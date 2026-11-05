"use strict";

const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { verifySecurityFeatures } = require("./security-verification");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SECURITY_DATABASE_PATH = path.resolve(
    process.env.SECURITY_DATABASE_PATH ||
    path.join(__dirname, "security-verifications.sqlite")
);

const DASHBOARD_PATH = path.join(
    __dirname,
    "../web-dashboard"
);

// Middleware
app.use(cors());
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

// Network information
const networkData = {
    project: "Secure Banking Network Infrastructure",
    status: "Online",

    headquarters: {
        name: "Head Office",
        router: "R1-HQ",
        ipAddress: "10.255.0.1",
        status: "Connectivity Tested",
        location: "Headquarters"
    },

    branch: {
        name: "Branch Office",
        router: "R2-BRANCH",
        ipAddress: "10.255.0.2",
        status: "Connectivity Tested",
        location: "Branch"
    },

    vlans: [
        {
            id: 10,
            name: "ATM Network",
            network: "10.10.10.0/24",
            gateway: "10.10.10.1"
        },
        {
            id: 20,
            name: "Banking Counter",
            network: "10.10.20.0/24",
            gateway: "10.10.20.1"
        },
        {
            id: 30,
            name: "Banking Server",
            network: "10.10.30.0/24",
            gateway: "10.10.30.1"
        },
        {
            id: 40,
            name: "Management",
            network: "10.10.40.0/24",
            gateway: "10.10.40.1"
        },
        {
            id: 50,
            name: "Customer Wi-Fi",
            network: "10.10.50.0/24",
            gateway: "10.10.50.1"
        },
        {
            id: 60,
            name: "Branch Network",
            network: "10.10.60.0/24",
            gateway: "10.10.60.1"
        },
        {
            id: 99,
            name: "Network Management",
            network: "10.10.99.0/24",
            gateway: "10.10.99.1"
        }
    ],

    servers: [
        {
            name: "BANK-SERVER",
            ipAddress: "10.10.30.10",
            role: "Banking Application Server",
            status: "Configured"
        },
        {
            name: "DHCP-DNS-SERVER",
            ipAddress: "10.10.30.11",
            role: "DHCP and DNS Server",
            status: "Configured"
        },
        {
            name: "WEB-SERVER",
            ipAddress: "10.10.30.12",
            role: "Web Server",
            status: "Configured"
        }
    ],

    routing: {
        protocol: "OSPF",
        status: "Configured",
        wanNetwork: "10.255.0.0/30"
    },

    services: {
        dhcp: "Configured",
        dns: "Configured",
        interVlanRouting: "Configured",
        branchConnectivity: "Tested"
    }

};

// API: Complete network information
app.get("/api/network", async (req, res, next) => {
    try {
        const securityReport = await runAndSaveSecurityVerification();
        res.json({
            ...networkData,
            security: securityReport.features
        });
    } catch (error) {
        next(error);
    }
});

// API: Head Office
app.get("/api/headquarters", (req, res) => {
    res.json(networkData.headquarters);
});

// API: Branch Office
app.get("/api/branch", (req, res) => {
    res.json(networkData.branch);
});

// API: VLAN information
app.get("/api/vlans", (req, res) => {
    res.json(networkData.vlans);
});

// API: Server information
app.get("/api/servers", (req, res) => {
    res.json(networkData.servers);
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
app.get("/api/services", (req, res) => {
    res.json(networkData.services);
});

// API: Routing information
app.get("/api/routing", (req, res) => {
    res.json(networkData.routing);
});

// API: Connectivity
app.get("/api/connectivity", (req, res) => {
    res.json({
        headquarters: networkData.headquarters,
        branch: networkData.branch,
        routing: networkData.routing
    });
});

// API: Health check
app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        message: "Backend API is working successfully",
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

    res.status(500).json({
        success: false,
        message: "Internal server error"
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