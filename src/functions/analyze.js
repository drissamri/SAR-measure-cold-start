const _ = require("lodash");
const AWS = require("aws-sdk");
const CloudWatchLogs = new AWS.CloudWatchLogs();
const Retry = require("async-retry");

const queryString = `
fields @memorySize / 1000000 as memorySize
  | filter @message like /(?i)(Init Duration)/
  | parse @message /^REPORT.*Init Duration: (?<initDuration>.*) ms.*/
  | parse @log /^.*\\/aws\\/lambda\\/(?<functionName>.*)/
  | stats count() as coldStarts, 
          min(initDuration) as min,
          percentile(initDuration, 25) as fstQuartile,
          median(initDuration) as median, 
          percentile(initDuration, 75) as trdQuartile,
          percentile(initDuration, 95) as p95,
          max(initDuration) as max,
          stddev(initDuration) as stddev
    by functionName, memorySize`;

module.exports.handler = async ({ startTime, functionName }) => {
	const endTime = new Date();
	const logGroupNames = [`/aws/lambda/${functionName}`];
	const startResp = await CloudWatchLogs.startQuery({
		logGroupNames,
		startTime: new Date(startTime).getTime() / 1000,
		endTime: endTime.getTime() / 1000,
		queryString
	}).promise();

	const queryId = startResp.queryId;
	const rows = await Retry(
		async () => {
			const resp = await CloudWatchLogs.getQueryResults({
				queryId
			}).promise();

			if (resp.status !== "Complete") {
				throw new Error("query result not ready yet...");
			}

			return resp.results;
		},
		{
			retries: 200, // 10 mins
			minTimeout: 3000,
			maxTimeout: 3000
		}
	);
  
	const result = rows.map(fields => {
		return _.reduce(
			fields,
			(acc, field) => {
				acc[field.field] = tryParseFloat(field.value);
				return acc;
			},
			{}
		);
	});

	return {
		functionName,
		result
	};
};

function tryParseFloat(str) {
	const n = parseFloat(str);
	return _.isNaN(n) ? str : n;
}