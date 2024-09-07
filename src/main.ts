import { assert } from "node:console";
import {
  ACCEPT_KEY,
  CONTENT_TYPE_KEY,
  DEFAULT_ENCODING,
  DEFAULT_ERROR_STATUS_CODE,
  getStatusText,
  GQL_RESPONSE_CONTENT_TYPE,
  GQL_RESPONSE_MEDIA_TYPE,
} from "./constant.js";
import {
  includeMediaType,
  parseMediaRange,
  parseMediaType,
} from "./media-type.js";
import {
  GqlImpl,
  GqlRequestErrorResponseAndHttpStatus,
  GqlResponseAndHttpStatus,
  GqlRequest,
  GqlResponse,
  isGqlSuccessOrPartialSuccess,
  MaybeGqlRequestError,
  isGqlRequestErrorResponseAndHttpStatus,
  StatusCode,
} from "./type.js";

const GET_REQ_MEDIA_TYPE = "application/x-www-form-urlencoded";
const POST_REQ_MEDIA_TYPE = "application/json";

const buildSimpleGqlRequestErrorResponse = (
  statusCode: StatusCode = DEFAULT_ERROR_STATUS_CODE
): GqlRequestErrorResponseAndHttpStatus => {
  return {
    httpResult: { statusCode, message: null },
    gqlResponse: {
      errors: [
        {
          message: getStatusText(statusCode),
          locations: [],
        },
      ],
      extensions: {},
    },
  };
};

const isStringRecord = (o: unknown): o is Record<string, unknown> => {
  return !!o && typeof o === "object" && !Buffer.isBuffer(o) && !Array.isArray(o);
};

const isNonEmptyStringRecord = (o: unknown): o is Record<string, unknown> => {
  return isStringRecord(o) && Object.keys(o).length > 0;
};

const isGqlRequest = (data: unknown): data is GqlRequest => {
  if (!isStringRecord(data)) return false;

  const len = Object.keys(data).length;
  if (len < 1 || len > 4) return false;
  // Since the key "query" is required, the length must be at least 1.
  // The keys "operationName", "variables", and "extensions" are optional, so the length can be up to 4.

  let keyCount = 0;

  // @spec: S25, S32, S34, S62
  // does not have to parse or validate the query string.
  if (!("query" in data) || typeof data["query"] !== "string") return false;
  keyCount++;

  // @spec: S26, S63
  if ("operationName" in data) {
    // @spec: S32
    if (typeof data["operationName"] !== "string") return false;
    keyCount++;
  }

  // @spec: S27, S64
  if ("variables" in data) {
    // @spec: S32
    if (!isStringRecord(data["variables"])) return false;
    keyCount++;
  }

  // @spec: S28, S65
  if ("extensions" in data) {
    // @spec: S32
    if (!isStringRecord(data["extensions"])) return false;
    keyCount++;
  }

  // @spec: S66
  // Other keys are not allowed.
  if (keyCount !== len) return false;

  return true;
};

export const validatePostRequestHeaders = (
  headers: Request["headers"]
): GqlRequestErrorResponseAndHttpStatus | null => {
  // @spec: S35, S36, S79
  // While S79 states that a request without an Accept header SHOULD be treated
  // as if it included `Accept: application/graphql-response+json`,
  // S36 indicates that the server MAY respond with an error to such a request.
  // For simplicity, this library treats such requests as errors.
  const clientAcceptableMediaType = headers.get(ACCEPT_KEY);
  if (!clientAcceptableMediaType) {
    // S5: 4xx or 5xx status code
    return buildSimpleGqlRequestErrorResponse();
  }

  // @spec: S37
  // S37 implies that if a client supplies an Accept header,
  // requests with an unparsable Accept header are not allowed.
  const mediaRange = parseMediaRange(clientAcceptableMediaType);
  if (!mediaRange) {
    // @spec: S86, S87, S88
    return buildSimpleGqlRequestErrorResponse();
  }
  // @spec: S16, S37, S38, S39, S76, S77, S78
  // Due to S39, `application/json` is no longer required after the watershed,
  // so this library does not check whether the Accept header includes `application/json`.
  // TODO: S75
  // This library doesn't know what to do in the case that the Accept header contains application/json but does not contain application/graphql-response+json.
  if (!includeMediaType(mediaRange, GQL_RESPONSE_MEDIA_TYPE)) {
    // @spec: S73, S74
    return buildSimpleGqlRequestErrorResponse(406);
  }

  const contentType = headers.get(CONTENT_TYPE_KEY);
  // @spec: S53, S56, S57
  // This library does not utilize the option to assume the media type as stated in S57.
  if (contentType === null) {
    return buildSimpleGqlRequestErrorResponse();
  }
  const parsedContentType = parseMediaType(contentType);
  // @spec: S53
  if (parsedContentType === undefined) {
    return buildSimpleGqlRequestErrorResponse();
  }
  // @spec: S54, S60
  if (parsedContentType.mediaType !== POST_REQ_MEDIA_TYPE) {
    return buildSimpleGqlRequestErrorResponse();
  }
  const charset = parsedContentType.parameters["charset"];
  // @spec: S54, S58
  // Although S58 states that servers MAY support media types other than "UTF-8",
  // this library does not support them.
  if (charset !== undefined && charset !== DEFAULT_ENCODING) {
    return buildSimpleGqlRequestErrorResponse();
  }

  return null;
};

export const buildGqlRequestFromPost = async (
  httpRequest: Request
): Promise<MaybeGqlRequestError<GqlRequest>> => {
  assert(httpRequest.method === "POST");

  const validationResult = validatePostRequestHeaders(httpRequest.headers);
  if (validationResult !== null) {
    return validationResult;
  }

  // @spec: S52
  let body: unknown;
  try {
    // @spec: S61
    body = await httpRequest.json();
  } catch (e) {
    return buildSimpleGqlRequestErrorResponse(400);
  }

  // TODO: need null check?
  if (typeof body !== "object") {
    return buildSimpleGqlRequestErrorResponse(400);
  }

  if (!isGqlRequest(body)) {
    return buildSimpleGqlRequestErrorResponse(400);
  }
  return { data: body };
};

export const validateGetRequestHeaders = (
  headers: Request["headers"]
): GqlRequestErrorResponseAndHttpStatus | null => {
  // @spec: S35, S36, S79
  // While S79 states that a request without an Accept header SHOULD be treated
  // as if it included `Accept: application/graphql-response+json`,
  // S36 indicates that the server MAY respond with an error to such a request.
  // For simplicity, this library treats such requests as errors.
  const clientAcceptableMediaType = headers.get(ACCEPT_KEY);
  if (!clientAcceptableMediaType) {
    // S5: 4xx or 5xx status code
    return buildSimpleGqlRequestErrorResponse();
  }

  // S36, S37
  // S35を上書き
  const acceptableMediaRange = parseMediaRange(clientAcceptableMediaType);
  if (!acceptableMediaRange) {
    // S5, S95, S97, S98
    return buildSimpleGqlRequestErrorResponse();
  }
  // @spec: S16, S37, S38, S39                                         S35, S36, S37, S76, S78, S79, S81, S86
  // We don't check whether the Accept header contains application/json because of S37.
  // application/json is no longer required after the watershed.
  // We support application/graphql-response+json only. <-> TODO: 矛盾 S80
  if (!includeMediaType(acceptableMediaRange, GQL_RESPONSE_MEDIA_TYPE)) {
    // @spec:                                          S5, S95, S97, S98, S77
    return buildSimpleGqlRequestErrorResponse(406);
  }

  const contentType = headers.get(CONTENT_TYPE_KEY);
  if (!contentType) {
    // S5, S95, S97, S98
    return buildSimpleGqlRequestErrorResponse();
  }
  const parsedContentType = parseMediaType(contentType);
  if (parsedContentType === undefined) {
    // S5, S95, S97, S98
    return buildSimpleGqlRequestErrorResponse();
  }
  // @spec: S17, S42                                         S40

  // S17 warns that supporting other media types rather than "application/json" can be insecure.
  // But server should support "application/x-www-form-urlencoded" for GET requests.???

  // It is not explicitly written that the Content-Type header is required for GET requests or Content-Type header should be "application/x-www-form-urlencoded".
  // We interpret that S40 says the Content-Type header is required and should be "application/x-www-form-urlencoded".
  if (parsedContentType.mediaType !== GET_REQ_MEDIA_TYPE) {
    // @spec:                                          S5, S95, S97, S98
    return buildSimpleGqlRequestErrorResponse();
  }

  return null;
};

export const buildGqlRequestFromGet = (
  httpRequest: Request
): MaybeGqlRequestError<GqlRequest> => {
  assert(httpRequest.method === "GET");

  const validationResult = validateGetRequestHeaders(httpRequest.headers);
  if (validationResult !== null) {
    return buildSimpleGqlRequestErrorResponse();
  }

  // @spec: S42
  if (!URL.canParse(httpRequest.url)) {
    // @spec:                                    S5, S95, S97, S98
    return buildSimpleGqlRequestErrorResponse();
  }
  // @spec: S47                                         S45
  const searchParams = new URL(httpRequest.url).searchParams;

  const query = searchParams.get("query");
  // @spec: S43                                         S21
  if (query === null) {
    // @spec:                                          S5, S95, S97, S98, S115, S109
    // S115 examples POST requests, but as the interpretation of S115, it is also applicable to GET requests.
    return buildSimpleGqlRequestErrorResponse();
  }

  // @spec: S51                                         S41, S50, S51, S52
  // S41: "query" is string type (not null type) because it passes null check.
  //      "startWith" method also checks if the query value is empty or not.
  // TODO: Queryは許可する？
  if (!query.startsWith("query")) {
    return buildSimpleGqlRequestErrorResponse(405);
  }

  // @spec: S44                                         S22, S42, S44, S46
  // TODO: @spec: S46
  // If the operationName parameter is present, it is string. If not, it is null.
  // S44 doesn't affect the implementation.
  // If searchParams.get("operationName") is an empty string, null assigns operationNameParam because of S46.
  const operationNameStr = searchParams.get("operationName");
  // @spec: S48
  const operationName = operationNameStr !== "" ? operationNameStr : null;

  // @spec:                                          S23, S43
  let variables = {};
  const variablesStr = searchParams.get("variables");
  // TODO: permit empty string?
  if (variablesStr) {
    try {
      // @spec: S45
      variables = JSON.parse(variablesStr);
    } catch (e) {
      // @spec:                                          S5, S95, S97, S98, S43, S109
      return buildSimpleGqlRequestErrorResponse();
    }
  }

  // @spec:                                          S24, S43
  let extensions = {};
  const extensionsStr = searchParams.get("extensions");
  // TODO: permit empty string?
  if (extensionsStr) {
    try {
      // @spec: S45
      extensions = JSON.parse(extensionsStr);
    } catch (e) {
      // @spec:                                          S5, S95, S97, S98, S43, S109
      return buildSimpleGqlRequestErrorResponse();
    }
  }

  const gqlRequest = { query, operationName, variables, extensions };
  if (!isGqlRequest(gqlRequest)) {
    return buildSimpleGqlRequestErrorResponse();
  }

  return {
    data: gqlRequest,
  };
};

export const buildGqlRequest = async (
  httpRequest: Request
): Promise<MaybeGqlRequestError<GqlRequest>> => {
  if (httpRequest.method === "POST") {
    return await buildGqlRequestFromPost(httpRequest);
  } else if (httpRequest.method === "GET") {
    return buildGqlRequestFromGet(httpRequest);
  }
  // @spec: S23
  // Other HTTP methods than "POST" are "GET" only in this library.
  return buildSimpleGqlRequestErrorResponse(405);
};

export const buildGqlOverHttpResult = <T>(
  gqlResponse: GqlResponse<T>
): GqlResponseAndHttpStatus<T> => {
  if (isGqlSuccessOrPartialSuccess(gqlResponse)) {
    return {
      // @spec: S111, S112, S113, S114
      httpResult: { statusCode: 200, message: null },
      gqlResponse,
    };
  }
  return {
    // @spec: S115, S116, S117
    // TODO: 5xx
    httpResult: { statusCode: 400, message: null },
    gqlResponse,
  };
};

export const buildHttpResponse = <T>(
  gqlResponseAndHttpStatus: GqlResponseAndHttpStatus<T>
): Response => {
  const { gqlResponse, httpResult } = gqlResponseAndHttpStatus;
  const response = new Response(JSON.stringify(gqlResponse), {
    status: httpResult.statusCode,
    headers: {
      // @spec: S16, S17, S20, S71
      // S17 discourages supporting other media types rather than "JSON".
      CONTENT_TYPE_KEY: GQL_RESPONSE_CONTENT_TYPE,
    },
  });
  return response;
};

// @spec: S68
// well‐formed GraphQL response. not only when the request is well-formed, but also when the request is not well-formed.
export const handle = async <T>(
  httpRequest: Request,
  // @spec: S8
  // gqlImpl is usually made with GraphQL schema and resolver.
  gqlImpl: GqlImpl<T>
): Promise<GqlResponseAndHttpStatus<T>> => {
  const gqlRequest = await buildGqlRequest(httpRequest);
  if (isGqlRequestErrorResponseAndHttpStatus(gqlRequest)) {
    return gqlRequest;
  }
  const gqlResponse = await gqlImpl(gqlRequest.data);
  return buildGqlOverHttpResult(gqlResponse);
};
