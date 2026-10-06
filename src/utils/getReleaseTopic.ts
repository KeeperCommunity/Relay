import config, { SERVER_ENVIRONMENT } from "../config";

let env = "";

export const getReleaseTopic = (appVersion?) => {
  return getEnvSpecificReleaseTopic(appVersion);
};

export const getBroadcastTopic = () => {
  if (config.ENVIRONMENT === SERVER_ENVIRONMENT.PRODUCTION) {
    return "keeper-braodcast";
  } else if (config.ENVIRONMENT === SERVER_ENVIRONMENT.DEVELOPMENT) {
    return "dev-keeper-braodcast";
  }
};

export const getDeepLinkPrefix = () => {
  return env || getEnvSpecificDeepLinkEnv();
};
/*
 This creates a environment specific topic
 This will ensure release broadcasts can be
 made to specific envirnments
*/
const getEnvSpecificReleaseTopic = (appVersion?) => {
  let releaseTopic;
  switch (config.ENVIRONMENT) {
    case SERVER_ENVIRONMENT.PRODUCTION:
      releaseTopic = appVersion ? "release" + appVersion : "release";
      break;
    case SERVER_ENVIRONMENT.STAGING:
      releaseTopic = appVersion
        ? "release" + "_stage" + appVersion
        : "release" + "_stage";
      break;
    case SERVER_ENVIRONMENT.DEVELOPMENT:
      releaseTopic = appVersion
        ? "release" + "_dev" + appVersion
        : "release" + "_dev";
  }
  return releaseTopic;
};

// This will return the env prefix that is used for deep links
const getEnvSpecificDeepLinkEnv = () => {
  switch (config.ENVIRONMENT) {
    case SERVER_ENVIRONMENT.PRODUCTION:
      env = "/app";
      break;
    case SERVER_ENVIRONMENT.STAGING:
      env = "/sta";
      break;
    case SERVER_ENVIRONMENT.DEVELOPMENT:
      env = "/dev";
  }
  return env;
};
