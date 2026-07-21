// --- CONSTANTS: The Core Logic Rules ---
const BOT_DIRECTIONS = [
    { name: 'right', x: 1, y: 0 },
    { name: 'down', x: 0, y: 1 },
    { name: 'left', x: -1, y: 0 },
    { name: 'up', x: 0, y: -1 },
];

const BOT_COMMAND_LIBRARY = Object.freeze({
    move: 'move',
    turnLeft: 'turnLeft',
    turnRight: 'turnRight',
    pickup: 'pickup',
    dropoff: 'dropoff',
    scan: 'scan',
});

// Helper for Levenshtein distance calculation to provide accurate "did you mean" suggestions
function getLevenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1  // deletion
                    )
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

class BotController {
    constructor(options = {}) {
        this.bot = options.bot || { x: 2, y: 2, orientationIndex: 0 };
        this.gridWidth = options.gridWidth || 16;
        this.gridHeight = options.gridHeight || 16;
        this.gridSize = options.gridSize || 32;

        this.worldObjects = new Map(options.worldObjects || [['5,2', 'crate']]);
        this.deliveryZones = new Set(options.deliveryZones || ['6,2']);
        this.collisionObjects = new Set(options.collisionObjects || []);

        this.taskQueue = [];
        this.taskState = 'IDLE';
        this.inventory = 'empty';
        this.lastScanResult = 'empty';
        this.gold = options.gold || 0;
        this.commandDelayMs = options.commandDelayMs || 400;
        this.lastCommandAt = 0;

        // Rate limiting & execution lock properties
        this.lastExecutionAttemptAt = 0;
        this.executionCooldownMs = 1000;
    }

    getFacingVector() { return BOT_DIRECTIONS[this.bot.orientationIndex % BOT_DIRECTIONS.length]; }

    setTaskState(nextState) { this.taskState = nextState; }

    toTileKey(x, y) { return `${x},${y}`; }

    getFrontTile() {
        const direction = this.getFacingVector();
        return { x: this.bot.x + direction.x, y: this.bot.y + direction.y };
    }

    isInBounds(x, y) { return x >= 0 && y >= 0 && x < this.gridWidth && y < this.gridHeight; }

    isBlocked(x, y) {
        const key = this.toTileKey(x, y);
        return !this.isInBounds(x, y) || this.collisionObjects.has(key);
    }

    queueCommand(commandName) {
        this.taskQueue.push({ name: commandName });
    }

    tokenizeScript(scriptString) {
        const commands = [];
        const lines = scriptString.split('\n');
        const validCommands = Object.keys(BOT_COMMAND_LIBRARY);
        const collectedErrors = [];

        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();

            // Skip empty lines or full-line comments
            if (!trimmed || trimmed.startsWith('//')) {
                continue;
            }

            // Remove inline comments for token analysis
            const cleanContent = trimmed.split('//')[0].trim();
            if (!cleanContent) continue;

            // Strict C-like syntax validation: must end with a semicolon
            if (!cleanContent.endsWith(';')) {
                collectedErrors.push({
                    lineNum: i + 1,
                    lineText: rawLine,
                    message: `Expected ';' at end of statement`,
                    suggestion: `${cleanContent};`
                });
                continue;
            }

            // Strip trailing semicolon for function identification
            const stmtBody = cleanContent.slice(0, -1).trim();

            const tokenPattern = /^([a-zA-Z_]\w*)\s*\((.*?)\)$/;
            const match = stmtBody.match(tokenPattern);

            if (!match) {
                collectedErrors.push({
                    lineNum: i + 1,
                    lineText: rawLine,
                    message: `Invalid statement syntax structure`,
                    suggestion: `${stmtBody}();`
                });
                continue;
            }

            const commandName = match[1];

            // Case-sensitivity and spelling validation against available commands
            if (!BOT_COMMAND_LIBRARY[commandName]) {
                // Find closest suggestion using Levenshtein distance
                let closest = validCommands[0];
                let minDst = Infinity;
                validCommands.forEach(vc => {
                    const dst = getLevenshteinDistance(commandName, vc);
                    if (dst < minDst) {
                        minDst = dst;
                        closest = vc;
                    }
                });

                collectedErrors.push({
                    lineNum: i + 1,
                    lineText: rawLine,
                    message: `Use of undeclared or misspelled function '${commandName}'`,
                    suggestion: `${closest}(${match[2]});`
                });
                continue;
            }

            commands.push(commandName);
        }

        if (collectedErrors.length > 0) {
            throw collectedErrors; // Multi-line error collection handler
        }

        return commands;
    }

    parseAndExecute(scriptString) {
        // If a script is currently running or executing commands, ignore clicks completely
        if (this.taskQueue.length > 0 || this.taskState !== 'IDLE') {
            return;
        }

        clearErrorHighlights();

        try {
            const commandNames = this.tokenizeScript(scriptString);
            if (commandNames.length === 0) return;
            commandNames.forEach(cmd => this.queueCommand(cmd));
            
            // Lock UI button state and apply gray hue when execution sequence starts
            setRunButtonState(false);
        } catch (errs) {
            console.error(errs);
            if (Array.isArray(errs)) {
                highlightMultipleErrors(errs);
            } else if (errs && errs.lineNum) {
                highlightMultipleErrors([errs]);
            } else {
                this.displayError(`ERR: ${errs.message || errs}`);
            }
        }
    }

    displayError(message) {
        console.warn(message);
        const container = document.getElementById('VIEWPORT_ACTIVE');
        if (container && !document.getElementById('error-banner')) {
            const banner = document.createElement('div');
            banner.id = 'error-banner';
            banner.style.position = 'absolute';
            banner.style.top = '10px';
            banner.style.left = '50%';
            banner.style.transform = 'translateX(-50%)';
            banner.style.backgroundColor = '#93000a';
            banner.style.color = '#ffdad6';
            banner.style.padding = '4px 12px';
            banner.style.fontSize = '10px';
            banner.style.fontFamily = 'JetBrains Mono, monospace';
            banner.style.fontWeight = '700';
            banner.style.zIndex = '100';
            banner.style.border = '2px solid #ffb4ab';
            banner.textContent = message;
            container.appendChild(banner);

            setTimeout(() => {
                banner.remove();
            }, 2500);
        }
    }

    executeCommand(commandName) {
        switch (commandName) {
            case BOT_COMMAND_LIBRARY.move: return this.move();
            case BOT_COMMAND_LIBRARY.turnLeft: return this.turnLeft();
            case BOT_COMMAND_LIBRARY.turnRight: return this.turnRight();
            case BOT_COMMAND_LIBRARY.pickup: return this.pickup();
            case BOT_COMMAND_LIBRARY.dropoff: return this.dropoff();
            case BOT_COMMAND_LIBRARY.scan: return this.scan();
        }
    }

    move() {
        const direction = this.getFacingVector();
        const nextX = this.bot.x + direction.x;
        const nextY = this.bot.y + direction.y;
        if (this.isBlocked(nextX, nextY)) {
            this.setTaskState('BLOCKED');
            return;
        }
        this.setTaskState('MOVING');
        this.bot.x = nextX;
        this.bot.y = nextY;
        this.setTaskState('IDLE');
    }

    turnLeft() {
        this.setTaskState('TURNING');
        this.bot.orientationIndex = (this.bot.orientationIndex + 3) % BOT_DIRECTIONS.length;
        this.setTaskState('IDLE');
    }

    turnRight() {
        this.setTaskState('TURNING');
        this.bot.orientationIndex = (this.bot.orientationIndex + 1) % BOT_DIRECTIONS.length;
        this.setTaskState('IDLE');
    }

    pickup() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        if (this.worldObjects.get(key) === 'crate') {
            this.inventory = 'full';
            this.worldObjects.delete(key);
        }
    }

    dropoff() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        if (this.deliveryZones.has(key) && this.inventory === 'full') {
            this.inventory = 'empty';
            this.gold += 50;
            const goldEl = document.getElementById('ui-gold');
            if (goldEl) {
                goldEl.innerHTML = `${this.gold} <span class="text-[10px]">AU</span>`;
            }
        }
    }

    scan() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        this.lastScanResult = this.worldObjects.get(key) || 'empty';
    }

    update(now = performance.now()) {
        if (this.taskState !== 'IDLE' || this.taskQueue.length === 0) return;
        if (now - this.lastCommandAt < this.commandDelayMs) return;
        
        const nextTask = this.taskQueue.shift();
        this.lastCommandAt = now;
        this.executeCommand(nextTask.name);

        // Check if queue has fully completed execution; if so, restore button interactivity & color
        if (this.taskQueue.length === 0 && this.taskState === 'IDLE') {
            setRunButtonState(true);
        }
    }
}

// Button State Handler for Gray Hue & Interactivity Lock
function setRunButtonState(isInteractive) {
    const btn = document.getElementById('run-script-btn');
    if (!btn) return;
    
    if (isInteractive) {
        btn.removeAttribute('disabled');
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        // Restore original yellow/amber container color scheme
        btn.className = "mt-4 bg-primary-container text-on-primary-container font-code-sm text-code-sm py-3 pixel-border hover:brightness-110 active:shadow-[inset_2px_2px_0px_#000] transition-all flex items-center justify-center gap-2 group";
    } else {
        btn.setAttribute('disabled', 'true');
        btn.style.opacity = '0.65';
        btn.style.cursor = 'not-allowed';
        // Apply grayed-out hue styling matching surface-container variants
        btn.className = "mt-4 bg-surface-container-high text-on-surface-variant font-code-sm text-code-sm py-3 pixel-border transition-all flex items-center justify-center gap-2 group";
    }
}

// Compiler Error Highlighting helpers supporting Multiple Lines & Red Bar Highlights
function highlightMultipleErrors(errors) {
    const errorSummaries = [];

    errors.forEach(err => {
        // Highlight line number element in red
        const lineNumEl = document.getElementById(`line-num-${err.lineNum}`);
        if (lineNumEl) {
            lineNumEl.style.backgroundColor = '#93000a';
            lineNumEl.style.color = '#ffdad6';
            lineNumEl.style.fontWeight = '700';
        }
        errorSummaries.push(`[Line ${err.lineNum}]: ${err.message} <span style="color: #ffd588;">(suggestion: ${err.suggestion})</span>`);
    });

    const container = document.getElementById('VIEWPORT_ACTIVE');
    if (container) {
        const existingBanner = document.getElementById('error-banner');
        if (existingBanner) existingBanner.remove();

        const banner = document.createElement('div');
        banner.id = 'error-banner';
        banner.style.position = 'absolute';
        banner.style.top = '10px';
        banner.style.left = '50%';
        banner.style.transform = 'translateX(-50%)';
        banner.style.backgroundColor = '#93000a';
        banner.style.color = '#ffdad6';
        banner.style.padding = '8px 16px';
        banner.style.fontSize = '10px';
        banner.style.fontFamily = 'JetBrains Mono, monospace';
        banner.style.fontWeight = '700';
        banner.style.zIndex = '100';
        banner.style.border = '2px solid #ffb4ab';
        banner.style.textAlign = 'left';
        banner.style.maxWidth = '90%';
        banner.style.maxHeight = '150px';
        banner.style.overflowY = 'auto';
        banner.innerHTML = `<strong>COMPILE_ERR (${errors.length} issue${errors.length > 1 ? 's' : ''} detected):</strong><br>` + errorSummaries.join('<br>');
        container.appendChild(banner);
    }
}

function clearErrorHighlights() {
    const lineNumbersEl = document.getElementById('code-line-numbers');
    if (lineNumbersEl) {
        Array.from(lineNumbersEl.children).forEach(child => {
            child.style.backgroundColor = '';
            child.style.color = '';
            child.style.fontWeight = '';
        });
    }
    const banner = document.getElementById('error-banner');
    if (banner) banner.remove();
}

// --- VISUALIZER: Strict 32x32 Snap & Elements ---
function initBotVisualizer(controller, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const crateEl = document.createElement('div');
    crateEl.style.position = 'absolute';
    crateEl.style.width = '32px';
    crateEl.style.height = '32px';
    crateEl.style.backgroundColor = '#f4b41b';
    crateEl.style.left = (5 * 32) + 'px';
    crateEl.style.top = (2 * 32) + 'px';
    crateEl.style.border = '2px solid #ffd588';
    crateEl.style.display = 'flex';
    crateEl.style.alignItems = 'center';
    crateEl.style.justifyContent = 'center';
    crateEl.innerHTML = '<span class="material-symbols-outlined text-xs text-on-primary">box</span>';
    container.appendChild(crateEl);

    const zoneEl = document.createElement('div');
    zoneEl.style.position = 'absolute';
    zoneEl.style.width = '32px';
    zoneEl.style.height = '32px';
    zoneEl.style.backgroundColor = 'rgba(140, 242, 114, 0.2)';
    zoneEl.style.left = (6 * 32) + 'px';
    zoneEl.style.top = (2 * 32) + 'px';
    zoneEl.style.border = '2px dashed #8cf272';
    container.appendChild(zoneEl);

    const botElement = document.createElement('div');
    botElement.style.position = 'absolute';
    botElement.style.width = '32px';
    botElement.style.height = '32px';
    botElement.style.backgroundColor = '#ffd588';
    botElement.style.border = '2px solid #412d00';
    botElement.style.zIndex = '50';
    botElement.style.display = 'flex';
    botElement.style.alignItems = 'center';
    botElement.style.justifyContent = 'center';
    botElement.innerHTML = '<div style="width: 8px; height: 8px; background: #412d00;"></div>';
    container.appendChild(botElement);

    function updateVisuals() {
        const x = controller.bot.x * controller.gridSize;
        const y = controller.bot.y * controller.gridSize;
        botElement.style.left = x + 'px';
        botElement.style.top = y + 'px';

        if (controller.inventory === 'full') {
            crateEl.style.display = 'none';
        } else {
            crateEl.style.display = 'flex';
        }

        requestAnimationFrame(updateVisuals);
    }
    updateVisuals();
}

// Initialize Controller & Systems globally
window.botController = new BotController({ commandDelayMs: 400 });
initBotVisualizer(window.botController, 'VIEWPORT_ACTIVE');

// Main Game Loop Engine Tick
function gameLoop() {
    if (window.botController) {
        window.botController.update();
    }
    requestAnimationFrame(gameLoop);
}
gameLoop();