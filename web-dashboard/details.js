"use strict";

const API = window.location.protocol === "file:"
    ? "http://localhost:3001/api"
    : "/api";

const params = new URLSearchParams(window.location.search);
const type = params.get("type") || (params.has("office") ? "office" : null);
const requestedId = params.get("id") || params.get("office");
const id = requestedId === "headquarters" ? "hq" : requestedId;
const title = document.getElementById("pageTitle");
const description = document.getElementById("pageDescription");
const container = document.getElementById("detailsContainer");
const error = document.getElementById("errorMessage");

function formatLabel(value) {
    const acronyms = new Set(["acl", "dhcp", "dns", "id", "ip", "nat", "ospf", "ssh", "vlan", "vpn", "wan"]);
    return value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .split(" ")
        .map(word => acronyms.has(word.toLowerCase())
            ? word.toUpperCase()
            : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(" ");
}

function addDetail(label, value) {
    const card = document.createElement("article");
    card.className = "detail-value-card";
    const heading = document.createElement("h2");
    heading.textContent = formatLabel(label);
    const paragraph = document.createElement("p");
    paragraph.textContent = value === null || value === undefined
        ? "Not available"
        : String(value);
    card.append(heading, paragraph);
    container.appendChild(card);
}

async function fetchData(endpoint) {
    const response = await fetch(`${API}${endpoint}`);
    if (!response.ok) {
        throw new Error(`Project API error: ${response.status}`);
    }
    return response.json();
}

async function loadDetails() {
    try {
        container.replaceChildren();
        error.textContent = "";
        let data;

        if (type === "office") {
            const endpoint = id === "hq"
                ? "/headquarters"
                : id === "branch"
                    ? "/branch"
                    : null;
            if (!endpoint) throw new Error("Invalid office selection");
            data = await fetchData(endpoint);
            title.textContent = data.name || "Office details";
            description.textContent = `Network and router information for ${data.name || "this office"}.`;
        } else if (type === "vlan") {
            const vlans = await fetchData("/vlans");
            if (!Array.isArray(vlans)) throw new Error("Invalid VLAN data received from the project API");
            data = vlans.find(item => String(item.id) === id);
            if (!data) throw new Error("VLAN not found");
            title.textContent = `VLAN ${data.id} · ${data.name}`;
            description.textContent = "Network segment and gateway information reported by the project API.";
        } else if (type === "server") {
            const servers = await fetchData("/servers");
            if (!Array.isArray(servers)) throw new Error("Invalid server data received from the project API");
            data = servers.find(item => item.name === id);
            if (!data) throw new Error("Server not found");
            title.textContent = data.name;
            description.textContent = "Server configuration reported by the project API.";
        } else if (type === "routing") {
            const connectivity = await fetchData("/connectivity");
            if (!connectivity.headquarters || !connectivity.branch || !connectivity.routing) {
                throw new Error("Incomplete inter-site routing data received from the project API");
            }

            title.textContent = "Inter-site routing";
            description.textContent = "OSPF routing and WAN endpoint information reported by the project API.";
            [
                ["Protocol", connectivity.routing.protocol],
                ["Status", connectivity.routing.status],
                ["WAN Network", connectivity.routing.wanNetwork],
                ["Head Office Router", connectivity.headquarters.router],
                ["Head Office IP Address", connectivity.headquarters.ipAddress],
                ["Head Office Connectivity", connectivity.headquarters.status],
                ["Branch Office Router", connectivity.branch.router],
                ["Branch Office IP Address", connectivity.branch.ipAddress],
                ["Branch Office Connectivity", connectivity.branch.status]
            ].forEach(([label, value]) => addDetail(label, value));
            return;
        } else if (type === "security") {
            if (id) {
                const report = await fetchData(`/security/${encodeURIComponent(id)}`);
                const result = report.result;
                if (!result || !Array.isArray(result.checks)) {
                    throw new Error("Invalid security verification result received from the project API");
                }
                title.textContent = formatLabel(report.feature);
                description.textContent = `${result.status} · ${result.summary}`;
                addDetail("Verification Status", result.status);
                result.checks.forEach(check => {
                    addDetail(check.name, `${check.status}: ${check.details}`);
                });
            } else {
                const report = await fetchData("/security");
                if (!report.features || typeof report.features !== "object") {
                    throw new Error("Invalid security verification report received from the project API");
                }
                title.textContent = "Network security";
                description.textContent = `Verification report generated ${new Date(report.generatedAt).toLocaleString()}.`;
                Object.entries(report.features).forEach(([feature, result]) => {
                    addDetail(formatLabel(feature), `${result.status}: ${result.summary}`);
                });
            }
            return;
        } else {
            throw new Error("Invalid details selection");
        }

        Object.entries(data).forEach(([key, value]) => {
            if (value === null || typeof value !== "object") addDetail(key, value);
        });
    } catch (err) {
        title.textContent = "Details unavailable";
        description.textContent = "The requested project information could not be loaded.";
        error.textContent = err instanceof Error
            ? `${err.message}. Confirm that the backend is running.`
            : "An unexpected error occurred while loading details.";
        console.error("Details could not be loaded:", err);
    }
}

loadDetails();
