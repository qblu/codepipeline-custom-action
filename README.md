# codepipeline-custom-action

CodePipeline custom action Lambda function wrapper

## Overview

This package provides a small collection of functions for constructing Lambda handler functions for use as CodePipeline custom actions. The primary benefit it provides is automatic conversion of input and output artifacts to and from objects. For example, the outputs from a CloudFormation changeset execution can be passed directly into a custom action handler without directly fiddling with encrypted S3 objects, zip files, or JSON parsing.

## Simple Usage

The library assumes your custom action will receive one input artifact and provide one output artifact. Each of these artifacts must be a zip file containing a single JSON file.

Provide a handler function to the `createAction` method. Your handler function must accept a CodePipeline job object and an input artifact object as its arguments, and it must return an array consisting of the job object and your output artifact object, or a Promise which resolves to such an array.

Here is an example of a custom action that will accept CloudFormation results as input and return an array of the Lambda ARNs found in those results:

```javascript
'use strict';

const createAction = require('codepipeline-custom-action').createAction;

exports.handler = createAction((job, input) => {
	let lambdasFound = [];
	console.log('Scanning CloudFormation outputs...');
	Object.keys(input)
		.forEach(key => {
			console.log(`${key}: ${input[key]}`);
			if (input[key].match(/^arn:aws:lambda:[^:]+:\d+:function:[^:]+$/)) {
				console.log(`Lambda function ${input[key]} found`);
				lambdasFound.push(input[key]);
			}
		});
	return [job, lambdasFound];
});
```

## Complex Usage

*to be written... for now, [see an example](https://github.com/qblu/codepipline-lambda-aliaser)*
