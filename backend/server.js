"use strict";

const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { verifySecurityFeatures } = require("./security-verification");
const { loadProjectData, loadProjectDocuments } = require("./project-data");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const allowedOrigins = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    "null",
    ...(process.env.API_ALLOWED_ORIGINS || "")
        .split(",")
        .map(origin => origin.trim())
        .filter(Boolean)
]);
const SECURITY_DATABASE_PATH = path.resolve(
    process.env.SECURITY_DATABASE_PATH ||
    path.join(__dirname, "security-verifications.sqlite")
);

const DASHBOARD_PATH = path.join(
    __dirname,
    "../web-dashboard"
);

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        callback(null, !origin || allowedOrigins.has(origin));
    }
}));
app.use(express.json());

fs.mkdirSync(path.dirname(SECURITY_DATABASE_PATH), { recursive: true });
const securityDatabase = new DatabaseSync(SECURITY_DATABASE_PATH);
securityDatabase.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS security_verification_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        generated_at TEXT NOT NULL,
        report_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_verification_results (
        run_id INTEGER NOT NULL REFERENCES security_verification_runs(id) ON DELETE CASCADE,
        feature TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('Verified', 'Not Configured', 'Verification Failed')),
        summary TEXT NOT NULL,
        details_json TEXT NOT NULL,
        PRIMARY KEY (run_id, feature)
    );
`);

function saveSecurityVerification(report) {
    const insertRun = securityDatabase.prepare(
        "INSERT INTO security_verification_runs (generated_at, report_json) VALUES (?, ?)"
    );
    const insertResult = securityDatabase.prepare(
        "INSERT INTO security_verification_results (run_id, feature, status, summary, details_json) VALUES (?, ?, ?, ?, ?)"
    );

    securityDatabase.exec("BEGIN IMMEDIATE");
    try {
        const runId = Number(insertRun.run(report.generatedAt, JSON.stringify(report)).lastInsertRowid);
        for (const [feature, result] of Object.entries(report.features)) {
            insertResult.run(runId, feature, result.status, result.summary, JSON.stringify(result));
        }
        securityDatabase.exec("COMMIT");
        return { ...report, runId };
    } catch (error) {
        try {
            securityDatabase.exec("ROLLBACK");
        } catch (rollbackError) {
            console.error("Could not roll back security verification database transaction:", rollbackError);
        }
        throw error;
    }
}

async function runAndSaveSecurityVerification() {
    return saveSecurityVerification(await verifySecurityFeatures());
}

// Serve only the project's user-facing documentation; device exports remain private.
app.get("/api/documents", async (req, res, next) => {
    try {
        const documents = await loadProjectDocuments();
        res.json({
            documents: documents.map(({ name, content }) => ({
                name,
                content,
                downloadUrl: `/api/documents/${encodeURIComponent(name)}?download=1`
            }))
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/documents/:name", async (req, res, next) => {
    try {
        const documents = await loadProjectDocuments();
        const document = documents.find(item => item.name === req.params.name);
        if (!document) {
            return res.status(404).json({
                success: false,
                message: "Project document not found"
            });
        }

        const disposition = req.query.download === "1" ? "attachment" : "inline";
        res.type("text/plain").set("Content-Disposition", `${disposition}; filename="${document.name}"`)
            .send(document.content);
    } catch (error) {
        next(error);
    }
});

// API: Complete network information
app.get("/api/network", async (req, res, next) => {
    try {
        res.json(await loadProjectData());
    } catch (error) {
        next(error);
    }
});

// API: Head Office
app.get("/api/headquarters", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).headquarters);
    } catch (error) {
        next(error);
    }
});

// API: Branch Office
app.get("/api/branch", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).branch);
    } catch (error) {
        next(error);
    }
});

// API: VLAN information
app.get("/api/vlans", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).vlans);
    } catch (error) {
        next(error);
    }
});

app.get("/api/vlans/:id", async (req, res, next) => {
    try {
        const vlan = (await loadProjectData()).vlans.find(item => item.id === Number(req.params.id));
        if (!vlan) {
            return res.status(404).json({ success: false, message: "VLAN not found in the project addressing plan" });
        }
        res.json(vlan);
    } catch (error) {
        next(error);
    }
});

// API: Server information
app.get("/api/servers", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).servers);
    } catch (error) {
        next(error);
    }
});

app.get("/api/servers/:name", async (req, res, next) => {
    try {
        const server = (await loadProjectData()).servers.find(
            item => item.name.toLowerCase() === req.params.name.toLowerCase()
        );
        if (!server) {
            return res.status(404).json({ success: false, message: "Server not found in the project addressing plan" });
        }
        res.json(server);
    } catch (error) {
        next(error);
    }
});

// API: Parsed configuration details, with credentials and raw device exports excluded
app.get("/api/configuration", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).security);
    } catch (error) {
        next(error);
    }
});

app.get("/api/configuration/:feature", async (req, res, next) => {
    try {
        const data = await loadProjectData();
        const feature = req.params.feature.toLowerCase();
        const configuration = {
            acl: { accessLists: data.security.accessLists },
            nat: data.security.nat,
            vpn: data.security.vpn,
            ssh: {
                devices: data.security.devices.map(device => ({
                    name: device.name,
                    ssh: device.ssh
                }))
            },
            vlan: { vlans: data.vlans },
        }[feature];

        if (!configuration) {
            return res.status(404).json({ success: false, message: "Configuration feature not found" });
        }
        res.json({ feature, source: data.sources, configuration });
    } catch (error) {
        next(error);
    }
});

// API: Latest security verification, refreshed against the current device exports
app.get("/api/security", async (req, res, next) => {
    try {
        res.json(await runAndSaveSecurityVerification());
    } catch (error) {
        next(error);
    }
});

// API: Persist a fresh security verification run
app.post("/api/security/verify", async (req, res, next) => {
    try {
        res.json(await runAndSaveSecurityVerification());
    } catch (error) {
        next(error);
    }
});

// API: Recent verification runs
app.get("/api/security/history", (req, res, next) => {
    try {
        const rows = securityDatabase.prepare(
            "SELECT id, generated_at, report_json FROM security_verification_runs ORDER BY id DESC LIMIT 20"
        ).all();
        res.json(rows.map(row => ({
            ...JSON.parse(row.report_json),
            runId: row.id,
            generatedAt: row.generated_at
        })));
    } catch (error) {
        next(error);
    }
});

// API: Fresh verification details for one security feature
app.get("/api/security/:feature", async (req, res, next) => {
    try {
        const report = await runAndSaveSecurityVerification();
        const feature = report.features[req.params.feature.toLowerCase()];
        if (!feature) {
            return res.status(404).json({
                success: false,
                message: "Security feature not found"
            });
        }
        res.json({
            generatedAt: report.generatedAt,
            runId: report.runId,
            feature: req.params.feature.toLowerCase(),
            result: feature
        });
    } catch (error) {
        next(error);
    }
});

// API: Network services
app.get("/api/services", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).services);
    } catch (error) {
        next(error);
    }
});

// API: Connectivity
app.get("/api/connectivity", async (req, res, next) => {
    try {
        res.json((await loadProjectData()).connectivity);
    } catch (error) {
        next(error);
    }
});

// API: Health check
app.get("/api/health", (req, res) => {
    const databaseCheck = securityDatabase.prepare("SELECT 1 AS ok").get();
    if (databaseCheck?.ok !== 1) {
        throw new Error("Security verification database health check failed");
    }

    res.json({
        success: true,
        message: "Backend API and verification database are healthy",
        database: "connected",
        timestamp: new Date().toISOString()
    });
});

// Serve frontend files
app.use(express.static(DASHBOARD_PATH));

// Main dashboard
app.get("/", (req, res) => {
    res.sendFile(
        path.join(DASHBOARD_PATH, "index.html")
    );
});

// API 404
app.use("/api", (req, res) => {
    res.status(404).json({
        success: false,
        message: "API route not found"
    });
});

// General 404
app.use((req, res) => {
    res.status(404).send("Page not found");
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err);

    res.status(err.statusCode || 500).json({
        success: false,
        message: err.statusCode === 503 ? err.message : "Internal server error"
    });
});

// Start backend
app.listen(PORT, () => {
    console.log("------------------------------------");
    console.log("SECURE BANKING NETWORK BACKEND");
    console.log("------------------------------------");

    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`Network API: http://localhost:${PORT}/api/network`);
    console.log(`Head Office: http://localhost:${PORT}/api/headquarters`);
    console.log(`Branch API: http://localhost:${PORT}/api/branch`);
    console.log(`VLAN API: http://localhost:${PORT}/api/vlans`);
    console.log(`Server API: http://localhost:${PORT}/api/servers`);
    console.log(`Security API: http://localhost:${PORT}/api/security`);
    console.log(`Services API: http://localhost:${PORT}/api/services`);
    console.log(`Health API: http://localhost:${PORT}/api/health`);

    console.log("------------------------------------");
});