export const commandName = (command) => command.constructor.name;

export const jsonBody = (response) => JSON.parse(response.body);

export const createContext = (remaining = 300_000) => ({
  getRemainingTimeInMillis: () => remaining,
});

export const createApiEvent = (body, headers = {}) => ({
  body: JSON.stringify(body),
  headers,
  requestContext: {
    domainName: "api.example.com",
    stage: "prod",
    identity: { apiKeyId: "api-key-id" },
  },
});
