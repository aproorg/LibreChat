const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  EModelEndpoint,
  Constants,
  removeNullishValues,
} = require('librechat-data-provider');
const { sleep } = require('~/server/utils');

const buildOptions = async ({ req, endpointOption }) => {
  const {
    AWS_REGION,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    PROXY,
  } = process.env;

  /** @type {number} */
  let streamRate = Constants.DEFAULT_STREAM_RATE;

  /** @type {undefined | TBaseEndpoint} */
  const bedrockConfig = req.app.locals[EModelEndpoint.bedrockAgent];

  if (bedrockConfig && bedrockConfig.streamRate) {
    streamRate = bedrockConfig.streamRate;
  }

  /** @type {undefined | TBaseEndpoint} */
  const allConfig = req.app.locals.all;
  if (allConfig && allConfig.streamRate) {
    streamRate = allConfig.streamRate;
  }

  /** @type {BedrockAgentClientOptions} */
  const requestOptions = {
    model: endpointOption.model,
    region: AWS_REGION,
    streaming: true,
    streamUsage: true,
    callbacks: [
      {
        handleLLMNewToken: async () => {
          if (!streamRate) {
            return;
          }
          await sleep(streamRate);
        },
      },
    ],
  };

  const configOptions = {};
  if (PROXY) {
    configOptions.httpAgent = new HttpsProxyAgent(PROXY);
  }

  return {
    /** @type {BedrockAgentClientOptions} */
    llmConfig: removeNullishValues(Object.assign(requestOptions, endpointOption.model_parameters)),
    configOptions,
  };
};

module.exports = buildOptions;
