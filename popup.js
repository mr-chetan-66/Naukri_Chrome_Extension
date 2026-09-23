const el = (id) => document.getElementById(id);

const statusDot = el("statusDot");
const statusLabel = el("statusLabel");
const statusMessage = el("statusMessage");
const statTotal = el("statTotal");
const statFollowed = el("statFollowed");
const statAlready = el("statAlready");
const statFailed = el("statFailed");
const batchLabel = el("batchLabel");
const batchProgress = el("batchProgress");
const failedList = el("failedList");
const batchSizeInput = el("batchSizeInput");
const startBtn = el("startBtn");
const stopBtn = el("stopBtn");
const continueBtn = el("continueBtn");
const resetBtn = el("resetBtn");

const STATUS_META = {
    "idle": { label: "Idle", color: "#6b7280" },
    "running": { label: "Running", color: "#2563eb" },
    "batch-paused": { label: "Batch paused", color: "#f59e0b" },
    "page-paused": { label: "Page paused", color: "#f59e0b" },
    "stopped": { label: "Stopped", color: "#6b7280" },
    "completed": { label: "Completed", color: "#16a34a" },
    "error": { label: "Error", color: "#dc2626" }
};

let batchSizeInitialized = false;

function render(state) {
    if (!state) return;

    const meta = STATUS_META[state.status] || STATUS_META.idle;
    statusDot.style.background = meta.color;
    statusLabel.textContent = meta.label;
    statusMessage.textContent = state.lastMessage || "";

    const stats = state.stats || { followed: 0, alreadyFollowing: 0, failed: 0 };
    statTotal.textContent = state.totalProcessed || 0;
    statFollowed.textContent = stats.followed || 0;
    statAlready.textContent = stats.alreadyFollowing || 0;
    statFailed.textContent = stats.failed || 0;

    batchLabel.textContent = `Batch ${state.batchNumber || 1}`;
    batchProgress.textContent = `${state.batchProcessed || 0} / ${state.batchSize || 25}`;

    const failed = state.failedCompanies || [];
    if (failed.length > 0) {
        failedList.style.display = "block";
        failedList.innerHTML = failed
            .slice(-10)
            .map(f => `<div>${f.reason || "Error"} — ${f.url || ""}</div>`)
            .join("");
    } else {
        failedList.style.display = "none";
        failedList.innerHTML = "";
    }

    if (!batchSizeInitialized) {
        batchSizeInput.value = state.batchSize || 25;
        batchSizeInitialized = true;
    }

    const isRunning = state.status === "running";
    const isPaused = state.status === "batch-paused" || state.status === "page-paused";
    const canResume = (state.status === "stopped" || state.status === "error") && (state.totalProcessed || 0) > 0;

    startBtn.textContent = canResume ? "Resume" : "Start";
    startBtn.disabled = isRunning || isPaused;

    stopBtn.disabled = !isRunning;

    continueBtn.style.display = isPaused ? "block" : "none";
    continueBtn.textContent = state.status === "page-paused" ? "Continue on next page" : "Continue batch";

    batchSizeInput.disabled = isRunning || isPaused;
}

function requestStatus() {
    chrome.runtime.sendMessage({ action: "getStatus" }, (response) => {
        if (response && response.state) {
            render(response.state);
        }
    });
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.naukriAutoFollowState) {
        render(changes.naukriAutoFollowState.newValue);
    }
});

startBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
        statusMessage.textContent = "No active tab found.";
        return;
    }

    if (!tab.url || !tab.url.includes("naukri.com")) {
        statusMessage.textContent = "Switch to your filtered Naukri list tab first, then click Start.";
        return;
    }

    let batchSize = parseInt(batchSizeInput.value, 10);
    if (!Number.isFinite(batchSize) || batchSize < 1) batchSize = 25;
    if (batchSize > 500) batchSize = 500;

    chrome.runtime.sendMessage({ action: "start", tabId: tab.id, batchSize }, () => requestStatus());
});

stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "stop" }, () => requestStatus());
});

continueBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "continueBatch" }, () => requestStatus());
});

resetBtn.addEventListener("click", () => {
    if (!confirm("Reset all progress (processed count, stats, batch position)? This cannot be undone.")) {
        return;
    }
    chrome.runtime.sendMessage({ action: "reset" }, () => {
        batchSizeInitialized = false;
        requestStatus();
    });
});

requestStatus();
