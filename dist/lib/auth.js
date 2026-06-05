export function isSecureMode() {
    return !!process.env.OPENCODE_SERVER_PASSWORD;
}
export function getAuthorizationHeader() {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password)
        return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    // Use Buffer for Node.js base64 encoding (btoa may not be available in all Node versions)
    const credentials = Buffer.from(`${username}:${password}`).toString("base64");
    return `Basic ${credentials}`;
}
export function configureClientAuth(client) {
    const authHeader = getAuthorizationHeader();
    if (!authHeader) {
        return client;
    }
    const innerClient = client._client || client.client;
    if (innerClient?.interceptors?.request) {
        innerClient.interceptors.request.use((request) => {
            if (!request.headers.has("Authorization")) {
                request.headers.set("Authorization", authHeader);
            }
            return request;
        });
        return client;
    }
    return client;
}
//# sourceMappingURL=auth.js.map