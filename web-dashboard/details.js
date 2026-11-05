"use strict";

const API = window.location.protocol === "file:"
    ? "http://localhost:3000/api"
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
    const acronyms = new Set(["acl", "dhcp", "dns", "id", "ip", "nat", "ssh", "vlan", "vpn", "wan"]);
    return value
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .split(" ")
        .map(word => acronyms.has(word.toLowerCase())
            ? word.toUpperCase()
            : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(" ");
}

function renderStructuredValue(parent, value) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            const empty = document.createElement("p");
            empty.className = "detail-empty";
            empty.textContent = "None listed";
            parent.appendChild(empty);
            return;
        }

        const list = document.createElement("div");
        list.className = "detail-entry-list";
        if (value.every(item => item === null || typeof item !== "object")) {
            list.classList.add("detail-entry-list-plain");
        }
        value.forEach((item, index) => {
            const entry = document.createElement("section");
            entry.className = "detail-entry";
            if (item && typeof item === "object" && !Array.isArray(item)) {
                const name = item.name || item.device || item.site || item.hostname;
                const headingText = item.device && item.interface
                    ? `${item.device} · ${item.interface}`
                    : name || `Entry ${index + 1}`;
                const heading = document.createElement("h3");
                heading.textContent = headingText;
                entry.appendChild(heading);
                renderStructuredValue(entry, item);
            } else {
                const text = document.createElement("p");
                text.className = "detail-entry-value";
                text.textContent = item === null || item === undefined
                    ? "Not available in the supplied project files"
                    : String(item);
                entry.appendChild(text);
            }
            list.appendChild(entry);
        });
        parent.appendChild(list);
        return;
    }

    if (value && typeof value === "object") {
        const fields = document.createElement("dl");
        fields.className = "detail-fields";
        Object.entries(value).forEach(([key, fieldValue]) => {
            const row = document.createElement("div");
            row.className = "detail-field";
            const label = document.createElement("dt");
            label.textContent = formatLabel(key);
            const content = document.createElement("dd");
            if (fieldValue !== null && typeof fieldValue === "object") {
                content.className = "detail-field-nested";
                renderStructuredValue(content, fieldValue);
            } else {
                content.textContent = fieldValue === null || fieldValue === undefined
                    ? "Not available in the supplied project files"
                    : String(fieldValue);
            }
            row.append(label, content);
            fields.appendChild(row);
        });
        parent.appendChild(fields);
        return;
    }

    const text = document.createElement("p");
    text.className = "detail-entry-value";
    text.textContent = value === null || value === undefined
        ? "Not available in the supplied project files"
        : String(value);
    parent.appendChild(text);
}

function addDetail(label, value, options = {}) {
    const card = document.createElement("article");
    card.className = "detail-value-card";
    if (options.wide) card.classList.add("detail-value-card-wide");
    const heading = document.createElement("h2");
    heading.textContent = formatLabel(label);
    card.appendChild(heading);
    renderStructuredValue(card, value);
    container.appendChild(card);
}

async function fetchData(endpoint) {
    let response;
    try {
        response = await fetch(`${API}${endpoint}`);
    } catch (error) {
        throw new Error(`Could not reach the project API. Start the backend and try again. ${error.message}`);
    }
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `Project API error: ${response.status}`);
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
            data = await fetchData(`/vlans/${encodeURIComponent(id)}`);
            title.textContent = `VLAN ${data.id} · ${data.name}`;
            description.textContent = "Network segment, router gateway, DHCP relay, and switch-port details parsed from the project exports.";
        } else if (type === "server") {
            data = await fetchData(`/servers/${encodeURIComponent(id)}`);
            title.textContent = data.name;
            description.textContent = "Addressing-plan details. Host configuration is not available in the supplied project exports.";
        } else if (type === "routing") {
            data = await fetchData("/connectivity");
            if (!data.interSiteRouting || !Array.isArray(data.interSiteRouting.endpoints)) {
                throw new Error("Incomplete inter-site routing information received from the project API");
            }

            title.textContent = "Inter-site routing";
            description.textContent = "WAN endpoints and inter-site connectivity evidence parsed from device exports and project documentation.";
            addDetail("Configuration Status", data.interSiteRouting.status);
            addDetail("WAN Network", data.interSiteRouting.wanNetwork);
            data.interSiteRouting.endpoints.forEach(endpoint => addDetail(endpoint.site, endpoint));
            addDetail("Inter-site Connectivity Evidence", data.interSiteRouting.evidence);
        } else if (type === "security") {
            if (id) {
                const [report, configReport] = await Promise.all([
                    fetchData(`/security/${encodeURIComponent(id)}`),
                    fetchData(`/configuration/${encodeURIComponent(id)}`)
                ]);
                const result = report.result;
                if (!result || !Array.isArray(result.checks)) {
                    throw new Error("Invalid security verification result received from the project API");
                }
                title.textContent = formatLabel(report.feature);
                description.textContent = `${result.status} · ${result.summary} Configuration details are parsed from the supplied device exports; no live devices are queried.`;
                addDetail("Verification Status", result.status);
                result.checks.forEach(check => {
                    addDetail(check.name, {
                        status: check.status,
                        details: check.details,
                        source: check.source
                    });
                });
                addDetail("Configuration from project exports", configReport.configuration, { wide: true });
                addDetail("Project source files", configReport.source, { wide: true });
            } else {
                const [report, configuration] = await Promise.all([
                    fetchData("/security"),
                    fetchData("/configuration")
                ]);
                if (!report.features || typeof report.features !== "object") {
                    throw new Error("Invalid security verification report received from the project API");
                }
                title.textContent = "Network security";
                description.textContent = `Verification report generated ${new Date(report.generatedAt).toLocaleString()}. Configuration below is parsed from project exports.`;
                Object.entries(report.features).forEach(([feature, result]) => {
                    addDetail(formatLabel(feature), `${result.status}: ${result.summary}`);
                });
                addDetail("Access Control Lists", configuration.accessLists, { wide: true });
                addDetail("SSH Configuration", configuration.devices.map(device => ({ name: device.name, ssh: device.ssh })), { wide: true });
                addDetail("NAT Configuration", configuration.nat);
                addDetail("VPN Configuration", configuration.vpn);
            }
            return;
        } else {
            throw new Error("Invalid details selection");
        }

        Object.entries(data).forEach(([key, value]) => {
            addDetail(key, value);
        });
    } catch (err) {
        title.textContent = "Details unavailable";
        description.textContent = "The requested project information could not be loaded.";
        error.textContent = err instanceof Error
            ? err.message
            : "An unexpected error occurred while loading details.";
        console.error("Details could not be loaded:", err);
    }
}

loadDetails();
