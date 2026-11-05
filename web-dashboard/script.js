"use strict";

const API = window.location.protocol === "file:"
    ? "http://localhost:3001/api"
    : "/api";

async function getAPI(endpoint) {
    const response = await fetch(`${API}${endpoint}`);
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
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
    } else if (/not configured|pending/i.test(status)) {
        element.classList.add("status-pending");
    } else if (/verification failed|unavailable|failed|offline|error/i.test(status)) {
        element.classList.add("status-offline");
    } else if (/configured/i.test(status)) {
        element.classList.add("status-configured");
    }
}

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
        setStatusChip(statusElements[0], data.headquarters?.status || "Information unavailable");
        setStatusChip(statusElements[1], data.branch?.status || "Information unavailable");
        document.getElementById("ospfStatus").textContent =
            data.routing?.status || "Information unavailable";
        setStatusChip(document.getElementById("routingStatus"), data.routing?.protocol || "Unavailable");
        apiStatus.textContent = "Connected";
        const indicator = document.getElementById("apiIndicator");
        if (indicator) indicator.classList.add("is-online");
    } catch (error) {
        statusElements.forEach(element => setStatusChip(element, "Unavailable"));
        document.getElementById("ospfStatus").textContent = "Unavailable";
        setStatusChip(document.getElementById("routingStatus"), "Unavailable");
        apiStatus.textContent = "API unavailable";
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
        cards.textContent = "VLAN information is unavailable. Check the project API and try again.";
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "table-message";
        cell.textContent = "Unable to load network and gateway addresses.";
        row.appendChild(cell);
        table.replaceChildren(row);
        status.textContent = "Check that the backend is running, then refresh this page.";
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
            role.textContent = server.role;
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
        container.textContent = "Server information is unavailable. Check the project API and try again.";
        console.error("Server information could not be loaded:", error);
    }
}

function renderSecurity(report) {
    if (!report.features || typeof report.features !== "object" || Array.isArray(report.features)) {
        throw new Error("Invalid security verification report received from the project API");
    }

    const container = document.getElementById("securityCards");
    container.replaceChildren(...Object.entries(report.features).map(([name, result]) => {
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
        container.textContent = "Security verification failed. Current feature statuses are unavailable.";
        document.getElementById("securityUpdated").textContent = "Verification unavailable";
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
        const response = await fetch(`${API}/security/verify`, { method: "POST" });
        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }
        renderSecurity(await response.json());
    } catch (error) {
        document.getElementById("securityCards").textContent =
            "Security verification failed. Previous statuses are no longer current.";
        document.getElementById("securityUpdated").textContent = "Verification failed";
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
            case "routing": {
                const [routing, connectivity, vlans] = await Promise.all([
                    getAPI("/routing"),
                    getAPI("/connectivity"),
                    getAPI("/vlans")
                ]);
                if (!routing || !connectivity?.headquarters || !connectivity?.branch || !Array.isArray(vlans)) {
                    throw new Error("Incomplete OSPF information received from the project API");
                }

                const documentedNetworks = [
                    ...vlans.map(vlan => vlan.network),
                    routing.wanNetwork
                ].filter(Boolean);
                text = [
                    "OSPF CONFIGURATION",
                    `Protocol: ${routing.protocol || "Not reported"}`,
                    `Status: ${routing.status || "Not reported"}`,
                    `WAN network: ${routing.wanNetwork || "Not reported"}`,
                    "",
                    "ROUTING & NEIGHBOR STATUS",
                    `${connectivity.headquarters.router || "Head Office"}: ${connectivity.headquarters.ipAddress || "IP not reported"}`,
                    `${connectivity.branch.router || "Branch Office"}: ${connectivity.branch.ipAddress || "IP not reported"}`,
                    `OSPF adjacency: Not reported by project API`,
                    `Reported site connectivity: Head Office ${connectivity.headquarters.status || "Not reported"} · Branch ${connectivity.branch.status || "Not reported"}`,
                    "",
                    "ROUTER IDs",
                    "Head Office: Not reported by project API",
                    "Branch Office: Not reported by project API",
                    "",
                    "NETWORK ADVERTISEMENTS",
                    "Advertised prefixes: Not reported by project API",
                    `Documented network prefixes (advertisement not confirmed): ${documentedNetworks.join(", ") || "None reported"}`
                ].join("\n");
                break;
            }
            case "services": {
                const data = await getAPI("/services");
                text = `DHCP: ${data.dhcp} · DNS: ${data.dns} · Inter-VLAN routing: ${data.interVlanRouting} · Branch connectivity: ${data.branchConnectivity}`;
                break;
            }
            case "connectivity": {
                const data = await getAPI("/connectivity");
                text = `Head Office (${data.headquarters?.ipAddress || "unavailable"}): ${data.headquarters?.status || "unavailable"} · Branch (${data.branch?.ipAddress || "unavailable"}): ${data.branch?.status || "unavailable"} · Routing: ${data.routing?.status || "unavailable"}`;
                break;
            }
            case "health": {
                const data = await getAPI("/health");
                text = data.message || "Backend health check completed.";
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
