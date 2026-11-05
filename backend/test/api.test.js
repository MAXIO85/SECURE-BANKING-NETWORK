"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");

const backendDirectory = path.resolve(__dirname, "..");
const temporaryDirectory = path.join(
    os.tmpdir(),
    `secure-banking-api-test-${process.pid}-${Date.now()}`
);
let baseUrl;
let serverProcess;
let serverOutput = "";

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    return port;
}

async function waitForServer() {
    const deadline = Date.now() + 15000;
    let lastError;
    while (Date.now() < deadline) {
        if (serverProcess.exitCode !== null) {
            throw new Error(`Test server exited unexpectedly: ${serverOutput}`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Test server did not become ready: ${lastError?.message}\n${serverOutput}`);
}

before(async () => {
    await fs.mkdir(temporaryDirectory, { recursive: true });
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, ["server.js"], {
        cwd: backendDirectory,
        env: {
            ...process.env,
            PORT: String(port),
            SECURITY_DATABASE_PATH: path.join(temporaryDirectory, "verification.sqlite")
        },
        stdio: ["ignore", "pipe", "pipe"]
    });
    serverProcess.stdout.setEncoding("utf8").on("data", chunk => { serverOutput += chunk; });
    serverProcess.stderr.setEncoding("utf8").on("data", chunk => { serverOutput += chunk; });
    await waitForServer();
});

after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
        serverProcess.kill();
        await new Promise(resolve => serverProcess.once("exit", resolve));
    }
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

async function requestJson(route, method = "GET") {
    const response = await fetch(`${baseUrl}${route}`, { method });
    return { response, body: await response.json() };
}

test("API responses provide the data consumed by the dashboard and detail views", async () => {
    const health = await requestJson("/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.database, "connected");

    const network = await requestJson("/api/network");
    assert.equal(network.response.status, 200);
    assert.ok(network.body.headquarters.router);
    assert.ok(network.body.branch.router);
    assert.ok(Array.isArray(network.body.sites) && network.body.sites.length > 0);
    assert.ok(Array.isArray(network.body.vlans) && network.body.vlans.length > 0);
    assert.ok(Array.isArray(network.body.servers) && network.body.servers.length > 0);
    assert.ok(network.body.interSiteRouting.wanNetwork);

    for (const route of ["/api/headquarters", "/api/branch"]) {
        const { response, body } = await requestJson(route);
        assert.equal(response.status, 200, route);
        assert.ok(body.router, route);
        assert.ok(body.ipAddress, route);
    }

    const vlans = await requestJson("/api/vlans");
    assert.equal(vlans.response.status, 200);
    assert.ok(vlans.body.some(vlan => vlan.network && vlan.gateway));
    const vlan = await requestJson("/api/vlans/10");
    assert.equal(vlan.response.status, 200);
    assert.equal(vlan.body.id, 10);
    assert.ok(vlan.body.network && vlan.body.gateway);

    const servers = await requestJson("/api/servers");
    assert.equal(servers.response.status, 200);
    assert.ok(servers.body.some(server => server.name && server.ipAddress));
    const server = await requestJson("/api/servers/BANK-SERVER");
    assert.equal(server.response.status, 200);
    assert.equal(server.body.name, "BANK-SERVER");

    const configuration = await requestJson("/api/configuration");
    assert.equal(configuration.response.status, 200);
    for (const feature of ["acl", "ssh", "nat", "vpn", "vlan"]) {
        const detail = await requestJson(`/api/configuration/${feature}`);
        assert.equal(detail.response.status, 200, feature);
        assert.equal(detail.body.feature, feature);
        assert.ok(detail.body.configuration);
    }

    const security = await requestJson("/api/security");
    assert.equal(security.response.status, 200);
    for (const feature of ["acl", "ssh", "nat", "vpn", "vlan"]) {
        assert.ok(security.body.features[feature], feature);
        assert.ok(Array.isArray(security.body.features[feature].checks), feature);
        const detail = await requestJson(`/api/security/${feature}`);
        assert.equal(detail.response.status, 200, feature);
        assert.equal(detail.body.feature, feature);
        assert.ok(Array.isArray(detail.body.result.checks));
    }

    const services = await requestJson("/api/services");
    assert.equal(services.response.status, 200);
    assert.ok(services.body.dhcp && services.body.dns);
    const connectivity = await requestJson("/api/connectivity");
    assert.equal(connectivity.response.status, 200);
    assert.ok(Array.isArray(connectivity.body.interSiteRouting.endpoints));

    const history = await requestJson("/api/security/history");
    assert.equal(history.response.status, 200);
    assert.ok(Array.isArray(history.body));
    assert.ok(history.body.length > 0);

    const documents = await requestJson("/api/documents");
    assert.equal(documents.response.status, 200);
    assert.ok(Array.isArray(documents.body.documents));
    const addressing = documents.body.documents.find(document => document.name === "IP-ADDRESSING.txt");
    assert.ok(addressing?.content.includes("VLAN 10 - ATM"));
    assert.ok(addressing.downloadUrl);
    const testingResults = documents.body.documents.find(
        document => document.name === "NETWORK-TESTING-RESULTS.txt"
    );
    assert.ok(testingResults?.content.includes("NETWORK TESTING RESULTS"));

    const overview = await fetch(`${baseUrl}/api/documents/PROJECT-OVERVIEW.txt`);
    assert.equal(overview.status, 200);
    assert.match(overview.headers.get("content-type"), /text\/plain/);
    assert.match(await overview.text(), /PROJECT OBJECTIVES/);

    const downloadedAddressing = await fetch(
        `${baseUrl}/api/documents/IP-ADDRESSING.txt?download=1`
    );
    assert.equal(downloadedAddressing.status, 200);
    assert.match(downloadedAddressing.headers.get("content-disposition"), /^attachment;/);
    assert.match(await downloadedAddressing.text(), /10\.10\.10\.0\/24/);
});

test("static dashboard pages and assets are served successfully", async () => {
    for (const route of [
        "/", "/index.html", "/details.html", "/documentation.html",
        "/script.js", "/details.js", "/documentation.js", "/style.css"
    ]) {
        const response = await fetch(`${baseUrl}${route}`);
        assert.equal(response.status, 200, route);
    }
});

test("unknown API resources return clear 404 responses", async () => {
    for (const route of [
        "/api/vlans/999",
        "/api/servers/MISSING",
        "/api/configuration/ospf",
        "/api/security/ospf",
        "/api/documents/MISSING.txt",
        "/api/documents/R1-HQ.txt"
    ]) {
        const { response, body } = await requestJson(route);
        assert.equal(response.status, 404, route);
        assert.equal(body.success, false, route);
        assert.ok(body.message, route);
    }
});
