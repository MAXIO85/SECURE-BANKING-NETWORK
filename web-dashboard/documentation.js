"use strict";

const API = window.location.protocol === "file:"
    ? "http://localhost:3000/api"
    : "/api";

const documentIndex = document.getElementById("documentIndex");
const documentsList = document.getElementById("documents");
const documentStatus = document.getElementById("documentStatus");

function documentId(name) {
    return `document-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/g, "")}`;
}

function renderDocuments(documents) {
    if (!Array.isArray(documents)) {
        throw new Error("The project API returned an invalid document list");
    }
    if (documents.length === 0) {
        documentIndex.replaceChildren();
        documentsList.textContent = "No project documentation files are currently available.";
        documentStatus.textContent = "No documents were returned by the project API.";
        return;
    }

    const indexLinks = [];
    const articles = [];
    documents.forEach(sourceDocument => {
        if (typeof sourceDocument.name !== "string" || typeof sourceDocument.content !== "string" ||
            typeof sourceDocument.downloadUrl !== "string") {
            throw new Error("The project API returned an incomplete document");
        }

        const id = documentId(sourceDocument.name);
        const indexLink = document.createElement("a");
        indexLink.href = `#${id}`;
        indexLink.className = "document-index-link";
        indexLink.textContent = sourceDocument.name;
        indexLinks.push(indexLink);

        const article = document.createElement("article");
        article.className = "document-card";
        article.id = id;
        const heading = document.createElement("div");
        heading.className = "document-card-heading";
        const title = document.createElement("h2");
        title.textContent = sourceDocument.name;
        const download = document.createElement("a");
        download.className = "button button-outline document-download";
        download.href = sourceDocument.downloadUrl;
        download.textContent = "Download original";
        heading.append(title, download);

        const content = document.createElement("pre");
        content.className = "document-content";
        const code = document.createElement("code");
        code.textContent = sourceDocument.content;
        content.append(code);
        article.append(heading, content);
        articles.push(article);
    });

    documentIndex.replaceChildren(...indexLinks);
    documentsList.replaceChildren(...articles);
    documentStatus.textContent = `${documents.length} source document${documents.length === 1 ? "" : "s"} loaded from the project.`;

    const requestedName = new URLSearchParams(window.location.search).get("file");
    if (requestedName) {
        const selected = documents.find(sourceDocument => sourceDocument.name === requestedName);
        if (selected) {
            document.getElementById(documentId(selected.name)).scrollIntoView();
        }
    }
}

async function loadDocuments() {
    try {
        const response = await fetch(`${API}/documents`);
        if (!response.ok) {
            let message = `Project documents could not be loaded (HTTP ${response.status})`;
            try {
                const error = await response.json();
                if (error.message) message = error.message;
            } catch (parseError) {
                console.error("Could not read the project document API error response:", parseError);
            }
            throw new Error(message);
        }
        const result = await response.json();
        renderDocuments(result.documents);
    } catch (error) {
        documentIndex.replaceChildren();
        documentsList.textContent = `Project documentation is unavailable: ${error.message}`;
        documentStatus.textContent = "Check that the backend is running and the source documents are available.";
        console.error("Project documentation could not be loaded:", error);
    }
}

loadDocuments();
