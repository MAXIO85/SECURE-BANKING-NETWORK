"use strict";

const API = window.location.protocol === "file:"
    ? "http://localhost:3000/api"
    : "/api";

async function getAPI(endpoint, options) {
    const response = await fetch(`${API}${endpoint}`, options);
    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || `API error: ${response.status}`);
    }
    return response.json();
}

function setStatusChip(element, value) {
    const status = String(value);
    element.textContent = status;
    element.classList.remove(
        "status-configured",
        "status-pending",
        "status-offline",
        "status-error",
        "status-verified"
    );

    if (/^verified$/i.test(status)) {
        element.classList.add("status-verified");
    } else if (/not configured|not live-tested|pending/i.test(status)) {
        element.classList.add("status-pending");
    } else if (/verification failed|unavailable|failed|offline|error/i.test(status)) {
        element.classList.add("status-offline");
    } else if (/configured/i.test(status)) {
        element.classList.add("status-configured");
    }
}

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

function setText(id, value, fallback = "Not reported in project files") {
    const element = document.getElementById(id);
    if (element) element.textContent = value === null || value === undefined || value === ""
        ? fallback
        : String(value);
}

function renderNetwork(data) {
    const headOffice = data.headquarters;
    const branch = data.branch;
    const branchVlan = data.vlans.find(vlan => vlan.site === "Branch Office");
    const headOfficeVlans = data.vlans.filter(vlan => vlan.site === "Head Office");
    const routing = data.interSiteRouting;

    document.getElementById("summarySites").textContent = String(data.sites.length).padStart(2, "0");
    document.getElementById("summaryVlans").textContent = String(data.vlans.length).padStart(2, "0");
    document.getElementById("summaryServers").textContent = String(data.servers.length).padStart(2, "0");
    setText("summarySitesNote", data.sites.map(site => site.name).join(" + "), "No sites listed in project files");
    setText("summaryVlansNote", data.vlans.length
        ? `VLAN IDs ${data.vlans.map(vlan => vlan.id).join(" · ")}`
        : "", "No VLANs listed in project files");
    const serverRoles = [...new Set(data.servers.map(server => server.role).filter(Boolean))];
    setText("summaryServersNote", serverRoles.join(" · "), "Server roles not reported in project files");
    setText("projectName", data.project?.name, "Project name not reported by the API");
    setText("projectSites", data.sites.map(site => site.name).join(" · "), "No sites listed in project files");
    setText("hqRouterName", headOffice.router);
    setText("hqRouterIp", headOffice.ipAddress);
    setText("branchRouterName", branch.router);
    setText("branchRouterIp", branch.ipAddress);
    setText("topologyHqRouter", headOffice.router);
    setText("topologyHqIp", headOffice.ipAddress);
    setText("topologyHqVlans", headOfficeVlans.map(vlan => vlan.id).join(" · "));
    setText("topologyWan", `Inter-site WAN · ${routing.wanNetwork || "network not documented"}`);
    setText("topologyBranchRouter", branch.router);
    setText("topologyBranchIp", branch.ipAddress);
    setText("topologyBranchNetwork", branchVlan?.network);
    setText("topologyBranchGateway", branchVlan?.gateway);
    setText("serverNetworkLabel", data.vlans.find(vlan => vlan.id === data.servers[0]?.vlanId)
        ? `Server network · VLAN ${data.servers[0].vlanId}`
        : "Server network not identified in project files");

    document.getElementById("interSiteRoutingStatus").textContent = routing.status;
    setStatusChip(document.getElementById("hqStatus"), headOffice.status);
    setStatusChip(document.getElementById("branchStatus"), branch.status);
    renderRouting(routing);
    renderProjectSources(data.project?.sourceFiles);
}

function renderRouting(routing) {
    if (!Array.isArray(routing.endpoints) || !routing.evidence || !routing.status) {
        throw new Error("Incomplete inter-site routing information received from the project API");
    }

    const container = document.getElementById("routingDetails");
    const summary = document.createElement("article");
    summary.className = "routing-card routing-summary";
    const heading = document.createElement("div");
    heading.className = "routing-card-heading";
    const title = document.createElement("h3");
    title.textContent = "WAN link";
    const status = document.createElement("span");
    status.className = "status-chip";
    setStatusChip(status, routing.status);
    heading.append(title, status);
    const network = document.createElement("p");
    network.className = "routing-network";
    network.textContent = `WAN network: ${routing.wanNetwork || "Not documented in project files"}`;
    const evidence = document.createElement("p");
    evidence.className = "routing-evidence";
    evidence.textContent = `Connectivity evidence: ${routing.evidence.status || "No status reported"}${routing.evidence.details ? ` — ${routing.evidence.details}` : ""}`;
    summary.append(heading, network, evidence);

    const endpoints = document.createElement("div");
    endpoints.className = "routing-endpoints";
    routing.endpoints.forEach(endpoint => {
        const card = document.createElement("article");
        card.className = "routing-endpoint";
        const site = document.createElement("span");
        site.className = "routing-endpoint-site";
        site.textContent = endpoint.site || "Site not identified";
        const router = document.createElement("h3");
        router.textContent = endpoint.router || "Router not identified";
        const address = document.createElement("p");
        address.textContent = `WAN address: ${endpoint.ipAddress || "Not identified in project exports"}`;
        card.append(site, router, address);
        endpoints.append(card);
    });
    container.replaceChildren(summary, endpoints);
}

function renderProjectSources(files) {
    if (!Array.isArray(files)) {
        throw new Error("Project source file inventory is missing from the network API response");
    }
    const list = document.getElementById("projectSources");
    if (files.length === 0) {
        list.replaceChildren();
        const empty = document.createElement("li");
        empty.className = "resource-empty";
        empty.textContent = "No source files were reported by the project API.";
        list.append(empty);
        return;
    }

    const documentedFiles = new Set([
        "PROJECT-OVERVIEW.txt",
        "IP-ADDRESSING.txt",
        "NETWORK-TESTING-RESULTS.txt"
    ]);
    list.replaceChildren(...files.map(file => {
        const item = document.createElement("li");
        item.className = "resource-item";
        const name = document.createElement("span");
        name.className = "resource-name";
        name.textContent = file;
        item.append(name);

        if (documentedFiles.has(file)) {
            const link = document.createElement("a");
            link.className = "resource-link";
            link.href = `documentation.html?file=${encodeURIComponent(file)}`;
            link.textContent = "Read source document ↗";
            item.append(link);
        } else {
            const label = document.createElement("span");
            label.className = "resource-kind";
            label.textContent = "Device configuration source";
            item.append(label);
        }
        return item;
    }));
}

function navigateToDetails(type, id) {
    window.location.href = `details.html?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`;
}

function createVlanCard(vlan) {
    const card = document.createElement("a");
    card.className = "vlan-card";
    card.href = `details.html?type=vlan&id=${encodeURIComponent(vlan.id)}`;

    const number = document.createElement("span");
    number.className = "vlan-number";
    number.textContent = String(vlan.id);

    const info = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = vlan.name;
    const network = document.createElement("small");
    network.textContent = vlan.network;
    info.append(name, network);
    card.append(number, info);
    return card;
}

function createVlanRow(vlan) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-label", `View VLAN ${vlan.id}, ${vlan.name}`);
    row.addEventListener("click", () => navigateToDetails("vlan", vlan.id));
    row.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigateToDetails("vlan", vlan.id);
        }
    });

    [vlan.id, vlan.name, vlan.network, vlan.gateway].forEach(value => {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        row.appendChild(cell);
    });

    const action = document.createElement("td");
    action.className = "table-action";
    action.setAttribute("aria-hidden", "true");
    action.textContent = "↗";
    row.appendChild(action);
    return row;
}

async function loadOverview() {
    const statusElements = [
        document.getElementById("hqStatus"),
        document.getElementById("branchStatus")
    ];
    const apiStatus = document.getElementById("apiStatus");

    try {
        const data = await getAPI("/network");
        if (!data.headquarters || !data.branch || !data.interSiteRouting || !Array.isArray(data.vlans) ||
            !Array.isArray(data.servers) || !Array.isArray(data.sites)) {
            throw new Error("Incomplete project inventory received from the API");
        }
        renderNetwork(data);
        apiStatus.textContent = "Connected";
        const indicator = document.getElementById("apiIndicator");
        if (indicator) indicator.classList.add("is-online");
    } catch (error) {
        statusElements.forEach(element => setStatusChip(element, "Unavailable"));
        document.getElementById("interSiteRoutingStatus").textContent = "Unavailable";
        document.getElementById("routingDetails").textContent =
            `Routing information is unavailable: ${error.message}`;
        document.getElementById("projectSources").textContent =
            `Project source inventory is unavailable: ${error.message}`;
        ["summarySites", "summaryVlans", "summaryServers"].forEach(id => setText(id, "—"));
        ["summarySitesNote", "summaryVlansNote", "summaryServersNote"].forEach(id =>
            setText(id, "", `Unavailable: ${error.message}`)
        );
        setText("projectName", "", `Unavailable: ${error.message}`);
        setText("projectSites", "", `Unavailable: ${error.message}`);
        apiStatus.textContent = `API unavailable: ${error.message}`;
        const indicator = document.getElementById("apiIndicator");
        if (indicator) indicator.classList.remove("is-online");
        console.error("Network overview could not be loaded:", error);
    }
}

async function loadVLANs() {
    const cards = document.getElementById("vlanCards");
    const table = document.getElementById("ipTable");
    const status = document.getElementById("ipLoadStatus");

    try {
        const vlans = await getAPI("/vlans");
        if (!Array.isArray(vlans)) {
            throw new Error("Invalid VLAN data received from the project API");
        }

        cards.replaceChildren(...vlans.map(createVlanCard));
        table.replaceChildren(...vlans.map(createVlanRow));
        status.textContent = `${vlans.length} VLAN network${vlans.length === 1 ? "" : "s"} · Select a row to view details.`;
    } catch (error) {
        cards.textContent = `VLAN information is unavailable: ${error.message}`;
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "table-message";
        cell.textContent = "Unable to load network and gateway addresses.";
        row.appendChild(cell);
        table.replaceChildren(row);
        status.textContent = `Unable to load VLANs: ${error.message}`;
        console.error("VLAN information could not be loaded:", error);
    }
}

async function loadServers() {
    const container = document.getElementById("serverCards");

    try {
        const servers = await getAPI("/servers");
        if (!Array.isArray(servers)) {
            throw new Error("Invalid server data received from the project API");
        }

        container.replaceChildren(...servers.map(server => {
            const card = document.createElement("a");
            card.className = "server-card";
            card.href = `details.html?type=server&id=${encodeURIComponent(server.name)}`;

            const icon = document.createElement("span");
            icon.className = "server-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = "▤";
            const state = document.createElement("span");
            state.className = "server-status";
            state.textContent = server.status;
            const heading = document.createElement("h3");
            heading.textContent = server.name;
            const role = document.createElement("p");
            role.className = "server-role";
            role.textContent = server.role || "Host configuration is not included in the exported project files";
            const meta = document.createElement("div");
            meta.className = "site-meta";
            const label = document.createElement("span");
            label.textContent = "IP address";
            const address = document.createElement("code");
            address.textContent = server.ipAddress;
            meta.append(label, address);
            card.append(icon, state, heading, role, meta);
            return card;
        }));
    } catch (error) {
        container.textContent = `Server information is unavailable: ${error.message}`;
        console.error("Server information could not be loaded:", error);
    }
}

function renderSecurity(report) {
    if (!report.features || typeof report.features !== "object" || Array.isArray(report.features)) {
        throw new Error("Invalid security verification report received from the project API");
    }

    const container = document.getElementById("securityCards");
    container.replaceChildren(...Object.entries(report.features).map(([name, result]) => {
        if (!["Verified", "Not Configured", "Verification Failed"].includes(result.status)) {
            throw new Error(`Invalid ${name} verification status received from the project API`);
        }
        const card = document.createElement("a");
        card.className = "security-card";
        card.href = `details.html?type=security&id=${encodeURIComponent(name)}`;
        const title = document.createElement("strong");
        title.textContent = formatLabel(name);
        const chip = document.createElement("span");
        chip.className = "status-chip";
        setStatusChip(chip, result.status);
        card.setAttribute("aria-label", `${formatLabel(name)}: ${result.status}. View verification details.`);
        card.append(title, chip);
        return card;
    }));
    document.getElementById("securityUpdated").textContent =
        `Last checked ${new Date(report.generatedAt).toLocaleString()}`;
}

async function loadSecurity() {
    const container = document.getElementById("securityCards");
    try {
        renderSecurity(await getAPI("/security"));
    } catch (error) {
        container.textContent = `Security verification failed: ${error.message}`;
        document.getElementById("securityUpdated").textContent = `Verification unavailable: ${error.message}`;
        console.error("Security information could not be loaded:", error);
    }
}

async function refreshSecurity() {
    const button = document.getElementById("refreshSecurity");
    const label = button.querySelector(".button-label");
    const originalLabel = label.textContent;
    button.disabled = true;
    label.textContent = "Verifying…";

    try {
        renderSecurity(await getAPI("/security/verify", { method: "POST" }));
    } catch (error) {
        document.getElementById("securityCards").textContent = `Security verification failed: ${error.message}`;
        document.getElementById("securityUpdated").textContent = `Verification failed: ${error.message}`;
        console.error("Security verification could not be refreshed:", error);
    } finally {
        button.disabled = false;
        label.textContent = originalLabel;
    }
}

async function runTool(tool, button) {
    const message = document.getElementById("message");
    message.classList.remove("success", "error");
    message.textContent = "Checking project API…";
    button.disabled = true;

    try {
        let text;
        switch (tool) {
            case "interSiteRouting": {
                const data = await getAPI("/connectivity");
                const routing = data.interSiteRouting;
                if (!routing || !Array.isArray(routing.endpoints)) {
                    throw new Error("Incomplete inter-site routing information received from the project API");
                }
                text = [
                    `Status: ${routing.status}`,
                    `WAN network: ${routing.wanNetwork || "Not documented"}`,
                    ...routing.endpoints.map(endpoint =>
                        `${endpoint.site} · ${endpoint.router}: ${endpoint.ipAddress || "WAN interface not identified"}`
                    ),
                    `Inter-site connectivity evidence: ${routing.evidence.status} — ${routing.evidence.details || "No test report details"}`
                ].join("\n");
                break;
            }
            case "services": {
                const data = await getAPI("/services");
                text = [
                    `DHCP: ${data.dhcp.status}; relay target(s): ${data.dhcp.serverAddresses.join(", ") || "none found"}`,
                    `DHCP test evidence: ${data.dhcp.evidence.status} — ${data.dhcp.evidence.details || "No test report details"}`,
                    `DNS: ${data.dns.status}; records: ${data.dns.records.join(", ") || "none documented"}`,
                    `DNS test evidence: ${data.dns.evidence.status} — ${data.dns.evidence.details || "No test report details"}`,
                    `Inter-VLAN routing: ${data.interVlanRouting.status}; ${data.interVlanRouting.evidence.status}`,
                    `Branch connectivity evidence: ${data.branchConnectivity.status} — ${data.branchConnectivity.details || "No test report details"}`,
                    `Customer Wi-Fi evidence: ${data.customerWifi.status} — ${data.customerWifi.details || "No test report details"}`
                ].join("\n");
                break;
            }
            case "connectivity": {
                const data = await getAPI("/connectivity");
                text = [
                    `${data.headquarters.router} (${data.headquarters.ipAddress}): ${data.headquarters.status}`,
                    `${data.branch.router} (${data.branch.ipAddress}): ${data.branch.status}`,
                    `Inter-site routing: ${data.interSiteRouting.status}`,
                    `Inter-site connectivity evidence: ${data.evidence.status} — ${data.evidence.details || "No test report details"}`
                ].join("\n");
                break;
            }
            case "health": {
                const data = await getAPI("/health");
                if (data.database !== "connected") {
                    throw new Error("The verification database is not healthy");
                }
                text = data.message;
                break;
            }
            default:
                throw new Error("Unknown network information tool");
        }
        message.textContent = text;
        message.classList.add("success");
    } catch (error) {
        message.textContent = `Unable to complete check: ${error.message}. Confirm that the backend is running.`;
        message.classList.add("error");
        console.error("Network tool could not complete:", error);
    } finally {
        button.disabled = false;
    }
}

function setupButtons() {
    document.querySelectorAll("[data-tool]").forEach(button => {
        button.addEventListener("click", () => runTool(button.dataset.tool, button));
    });

    document.getElementById("refreshSecurity").addEventListener("click", refreshSecurity);
}

document.addEventListener("DOMContentLoaded", () => {
    setupButtons();
    Promise.all([loadOverview(), loadVLANs(), loadServers(), loadSecurity()]);
});
