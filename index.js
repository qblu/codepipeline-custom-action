'use strict';

const Promise = require('bluebird');
const promiserToLambda = require('promiser-to-lambda');
const Zip = require('adm-zip');

const AWS = require('aws-sdk');
AWS.config.setPromisesDependency(Promise);

const codePipeline = new AWS.CodePipeline();

const verboseLog = (message, isError) => {
	if (process.env.VERBOSE === 'yes') {
		if (isError) {
			console.error(message);
		} else {
			console.log(message);
		}
	}
};

const verboseError = message => {
	verboseLog(message, true);
};

const createJobValidator = (numInputArtifacts, numOutputArtifacts) => {
	return job => {
		verboseLog('Validating CodePipeline job:');
		verboseLog(JSON.stringify(job, null, 2));

		if (!job.data) {
			throw new Error('CodePipeline job contained no data');
		}

		if (!job.data.inputArtifacts) {
			throw new Error('CodePipeline job data contained no inputArtifacts');
		}

		if (!job.data.outputArtifacts) {
			throw new Error('CodePipeline job data contained no outputArtifacts');
		}

		if (job.data.inputArtifacts.length !== numInputArtifacts) {
			throw new Error(`CodePipeline job data contained ${job.data.inputArtifacts.length} input artifact(s), but action was expecting ${numInputArtifacts}`);
		}

		if (job.data.outputArtifacts.length !== numOutputArtifacts) {
			throw new Error(`CodePipeline job data contained ${job.data.outputArtifacts.length} output artifact(s), but action was expecting ${numOutputArtifacts}`);
		}

		verboseLog('Creating S3 instance');

		job.s3 = new AWS.S3({
			signatureVersion: 'v4',
			secretAccessKey: job.data.artifactCredentials.secretAccessKey,
			sessionToken: job.data.artifactCredentials.sessionToken,
			accessKeyId: job.data.artifactCredentials.accessKeyId,
		});

		return job;
	};
};

const unzipArtifact = (artifactNum, artifactName, data) => {
	verboseLog(`Unzipping input artifact #${artifactNum} (${artifactName})`);

	const zip = new Zip(data.Body);
	const entries = zip.getEntries();

	if (entries.length !== 1) {
		throw new Error(`Expected input artifact #${artifactNum} (${artifactName}) zip to contain exactly 1 JSON file, but it contains ${entries.length} entries`);
	}

	verboseLog(`Reading data from input artifact #${artifactNum} (${artifactName})`);

	return zip.readAsText(entries[0]);
};

const parseInputJson = (artifactNum, artifactName, inputJson) => {
	verboseLog(`Parsing JSON from input artifact #${artifactNum} (${artifactName})`);
	try {
		return JSON.parse(inputJson);
	} catch (error) {
		verboseError(`JSON parse error for input artifact #${artifactNum} (${artifactName}): ${error}`);
		verboseLog(`Bad JSON from input artifact #${artifactNum} (${artifactName}):\n${inputJson}`);
		throw new Error(`Failed to parse JSON from input artifact #${artifactNum} (${artifactName})`);
	}
};

const defaultInputAdapter = job => {
	verboseLog(`Receiving ${job.data.inputArtifacts.length} input artifact(s)`);

	let gets = job.data.inputArtifacts.map((inputArtifact, index) => {
		const artifactNum = index + 1;

		if (inputArtifact.location.type !== 'S3') {
			throw new Error(`Unrecognized location type for input artifact #${artifactNum} (${inputArtifact.name}): '${inputArtifact.location.type}'`);
		}

		verboseLog(`Getting input artifact #${artifactNum} (${inputArtifact.name}) from s3://${inputArtifact.location.s3Location.bucketName}/${inputArtifact.location.s3Location.objectKey}`);

		const params = {
			Bucket: inputArtifact.location.s3Location.bucketName,
			Key: inputArtifact.location.s3Location.objectKey,
		};

		return job.s3.getObject(params)
			.promise()
			.then(unzipArtifact.bind(null, artifactNum, inputArtifact.name))
			.then(parseInputJson.bind(null, artifactNum, inputArtifact.name));
	});

	return [job].concat(gets);
};

const zipArtifact = (artifactNum, artifactName, output) => {
	verboseLog(`Zipping output artifact #${artifactNum} (${artifactName})`);
	let zip = new Zip();
	zip.addFile('output.json', JSON.stringify(output));
	return zip.toBuffer();
};

/**
 * Node 4.3.2 doesn't support spread syntax (...x), and arrow functions don't
 * support the `arguments` variable, so we will declare a classic variadic
 * function here.
 */
const defaultOutputAdapter = function defaultOutputAdapter() {
	// Convert arguments object into array
	let args = Array.prototype.slice.call(arguments);

	if (args.length === 0) {
		throw new Error('Output adapter expected to receive job followed by output(s) but instead received no arguments');
	}

	let job = args.shift();

	if (args.length !== job.data.outputArtifacts.length) {
		throw new Error(`Output adapter expected to receive job followed by ${job.data.outputArtifacts.length} output(s) but instead received ${args.length} output(s)`);
	}

	verboseLog(`Delivering ${job.data.outputArtifacts.length} output artifact(s)`);

	let puts = args.map((output, index) => {
		const artifactNum = index + 1;
		let outputArtifact = job.data.outputArtifacts[index];

		if (outputArtifact.location.type !== 'S3') {
			throw new Error(`Unrecognized location type for output artifact #${artifactNum} (${outputArtifact.name}): '${outputArtifact.location.type}'`);
		}

		const params = {
			Bucket: outputArtifact.location.s3Location.bucketName,
			Key: outputArtifact.location.s3Location.objectKey,
			Body: zipArtifact(artifactNum, outputArtifact.name, output),
			ServerSideEncryption: 'aws:kms',
		};

		verboseLog(`Putting output artifact #${artifactNum} (${outputArtifact.name}) to s3://${outputArtifact.location.s3Location.bucketName}/${outputArtifact.location.s3Location.objectKey}`);

		return job.s3.putObject(params)
			.promise()
			.then(data => {
				verboseLog(`Successfully put output artifact #${artifactNum} (${outputArtifact.name})`);
				return data;
			})
			.catch(error => {
				verboseError(`Failed to put output artifact #${artifactNum} (${outputArtifact.name})`);
				throw error;
			});
	});

	return [job].concat(puts);
};

const defaultOnJobCompletion = job => {
	verboseLog(`Marking CodePipeline job id ${job.id} as success`);
	return codePipeline.putJobSuccessResult({ jobId: job.id })
		.promise();
};

const defaultOnJobFailure = (job, error) => {
	verboseError(`Marking CodePipeline job id ${job.id} as failure`);

	const params = {
		jobId: job.id,
		failureDetails: {
			message: error.message || error.toString(),
			type: 'JobFailed',
		},
	};

	return codePipeline.putJobFailureResult(params)
		.promise();
};

const validateCreateActionParams = promiserOrParams => {
	let params;

	if (typeof promiserOrParams === 'function') {
		params = { inputHandler: promiserOrParams };
	} else if (!promiserOrParams.inputHandler) {
		throw new Error('No input handler specified when creating action');
	} else {
		params = promiserOrParams;
	}

	if (!params.jobValidator) {
		params.jobValidator = createJobValidator(
			params.numInputArtifacts || 1,
			params.numOutputArtifacts || 1
		);
	}

	if (!params.inputAdapter) {
		params.inputAdapter = defaultInputAdapter;
	}

	if (!params.outputAdapter) {
		params.outputAdapter = defaultOutputAdapter;
	}

	if (!params.onJobCompletion) {
		params.onJobCompletion = defaultOnJobCompletion;
	}

	if (!params.onJobFailure) {
		params.onJobFailure = defaultOnJobFailure;
	}

	return params;
};

const createAction = promiserOrParams => {
	let params = validateCreateActionParams(promiserOrParams);

	return promiserToLambda(event => {
		let job = event['CodePipeline.job'];

		if (!job) {
			throw new Error('Event did not contain CodePipeline.job');
		}

		return Promise.resolve(job)
			.then(params.jobValidator)
			.then(params.inputAdapter)
			.spread(params.inputHandler)
			.spread(params.outputAdapter)
			.spread(params.onJobCompletion)
			.catch(error => {
				params.onJobFailure(job, error);
				throw error;
			});
	});
};

module.exports = {
	createJobValidator,
	defaultInputAdapter,
	defaultOutputAdapter,
	defaultOnJobCompletion,
	defaultOnJobFailure,
	createAction,
};
