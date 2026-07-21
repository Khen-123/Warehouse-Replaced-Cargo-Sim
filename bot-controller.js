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
    isBlocked: 'isBlocked',
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

        // Cargo location at (3, 5)
        this.worldObjects = new Map(options.worldObjects || [['3,5', 'crate']]);
        // Delivery zone location at (7, 5)
        this.deliveryZones = new Set(options.deliveryZones || ['7,5']);
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

    isBlocked() {
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        return !this.isInBounds(front.x, front.y) || this.collisionObjects.has(key);
    }

    queueCommand(commandName) {
        this.taskQueue.push({ type: 'COMMAND', name: commandName });
    }

    evaluateCondition(condStr) {
        const clean = condStr.trim().replace(/\s+/g, '');
        if (clean === 'isBlocked()==false' || clean === '!isBlocked()' || clean === 'isBlocked()==1' === false) {
            return !this.isBlocked();
        }
        if (clean === 'isBlocked()==true' || clean === 'isBlocked()' || clean === 'isBlocked()==1') {
            return this.isBlocked();
        }
        if (clean.startsWith('scan()')) {
            const parts = clean.split('==');
            if (parts.length === 2) {
                const target = parts[1].trim().replace(/['"]/g, '');
                return this.scan() === target;
            }
        }
        return false;
    }

    tokenizeAndCompileScript(scriptString) {
        const lines = scriptString.split('\n');
        const validCommands = Object.keys(BOT_COMMAND_LIBRARY);
        const collectedErrors = [];

        // Pre-process script to handle multiline closures or line-splitting safely
        const tokens = [];
        lines.forEach((rawLine, idx) => {
            const lineNum = idx + 1;
            let trimmed = rawLine.trim();
            if (!trimmed || trimmed.startsWith('//')) return;

            // Handle inline closing braces or compound lines like `} else {`
            if (trimmed.includes('} else')) {
                const parts = trimmed.split('} else');
                tokens.push({ lineNum, text: parts[0].trim() + '}', raw: rawLine });
                tokens.push({ lineNum, text: 'else ' + parts[1].trim(), raw: rawLine });
                return;
            }

            if (trimmed.includes('}') && !trimmed.startsWith('}')) {
                const parts = trimmed.split('}');
                const firstPart = parts[0].trim();
                if (firstPart) tokens.push({ lineNum, text: firstPart, raw: rawLine });
                tokens.push({ lineNum, text: '}', raw: rawLine });
                const remaining = parts.slice(1).join('}').trim();
                if (remaining) tokens.push({ lineNum, text: remaining, raw: rawLine });
                return;
            }

            tokens.push({ lineNum, text: trimmed, raw: rawLine });
        });

        let tokenIndex = 0;

        const parseBlock = (isTopLevel = false) => {
            const instructions = [];

            while (tokenIndex < tokens.length) {
                const token = tokens[tokenIndex];
                const trimmed = token.text;
                const lineNum = token.lineNum;

                // Handle closing braces
                if (trimmed === '}' || trimmed.startsWith('}')) {
                    tokenIndex++;
                    if (isTopLevel) {
                        // At the top level, trailing closing braces closing compound blocks are safely skipped
                        continue;
                    }
                    return instructions;
                }

                // Handle WHILE loop block
                if (trimmed.startsWith('while')) {
                    const match = trimmed.match(/^while\s*\((.*?)\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ 
                            lineNum: lineNum, 
                            lineText: token.raw, 
                            message: `In line ${lineNum}: Invalid while loop syntax`, 
                            suggestion: `while (condition) {` 
                        });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ 
                            lineNum: lineNum, 
                            lineText: token.raw, 
                            message: `In line ${lineNum}: Missing opening bracket '{' after while condition`, 
                            suggestion: `while (${match[1]}) {` 
                        });
                    }
                    const condition = match[1].trim();
                    tokenIndex++;
                    const body = parseBlock(false);
                    instructions.push({
                        type: 'WHILE',
                        condition: condition,
                        body: body
                    });
                    continue;
                }

                // Handle FOR loop block
                if (trimmed.startsWith('for')) {
                    const match = trimmed.match(/^for\s*\((.*?)\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ 
                            lineNum: lineNum, 
                            lineText: token.raw, 
                            message: `In line ${lineNum}: Invalid for loop syntax`, 
                            suggestion: `for (let i = 0; i < 3; i++) {` 
                        });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ 
                            lineNum: lineNum, 
                            lineText: token.raw, 
                            message: `In line ${lineNum}: Missing opening bracket '{' after for loop declaration`, 
                            suggestion: `${trimmed} {` 
                        });
                    }
                    const headerParts = match[1].split(';');
                    let limit = 1;
                    if (headerParts.length >= 2) {
                        const numMatch = headerParts[1].match(/<\s*(\d+)/);
                        if (numMatch) limit = parseInt(numMatch[1], 10);
                    }

                    tokenIndex++;
                    const body = parseBlock(false);

                    for (let step = 0; step < limit; step++) {
                        body.forEach(cmd => instructions.push(JSON.parse(JSON.stringify(cmd))));
                    }
                    continue;
                }

                // Handle IF conditional block
                if (trimmed.startsWith('if')) {
                    const match = trimmed.match(/^if\s*\((.*?)\)\s*(\{)?/);
                    if (!match) {
                        collectedErrors.push({ lineNum: lineNum, lineText: token.raw, message: `In line ${lineNum}: Invalid if statement syntax`, suggestion: `if (condition) {` });
                        tokenIndex++;
                        continue;
                    }
                    if (!trimmed.includes('{')) {
                        collectedErrors.push({ 
                            lineNum: lineNum, 
                            lineText: token.raw, 
                            message: `In line ${lineNum}: Missing opening bracket '{' after if condition`, 
                            suggestion: `if (${match[1]}) {` 
                        });
                    }
                    const condition = match[1].trim();
                    tokenIndex++;
                    const ifBody = parseBlock(false);

                    let elseBody = [];
                    if (tokenIndex < tokens.length) {
                        let nextToken = tokens[tokenIndex];
                        if (nextToken.text.startsWith('else')) {
                            tokenIndex++; 
                            if (tokenIndex < tokens.length && tokens[tokenIndex].text === '{') {
                                tokenIndex++; 
                                elseBody = parseBlock(false);
                            } else if (nextToken.text.includes('{')) {
                                elseBody = parseBlock(false);
                            } else {
                                collectedErrors.push({
                                    lineNum: nextToken.lineNum,
                                    lineText: nextToken.raw,
                                    message: `In line ${nextToken.lineNum}: Missing opening bracket '{' after else statement`,
                                    suggestion: `else {`
                                });
                            }
                        }
                    }

                    instructions.push({
                        type: 'IF',
                        condition: condition,
                        ifBody: ifBody,
                        elseBody: elseBody
                    });
                    continue;
                }

                // Handle ELSE standalone token
                if (trimmed.startsWith('else')) {
                    collectedErrors.push({
                        lineNum: lineNum,
                        lineText: token.raw,
                        message: `In line ${lineNum}: Orphaned 'else' statement without a preceding 'if' block`,
                        suggestion: `Attach to an 'if' block`
                    });
                    tokenIndex++;
                    continue;
                }

                // Standard single line statements
                let cleanContent = trimmed.split('//')[0].trim();
                if (cleanContent.endsWith('{')) {
                    cleanContent = cleanContent.slice(0, -1).trim();
                }

                if (!cleanContent) {
                    tokenIndex++;
                    continue;
                }

                if (!cleanContent.endsWith(';')) {
                    collectedErrors.push({
                        lineNum: lineNum,
                        lineText: token.raw,
                        message: `In line ${lineNum}: Expected ';' at end of statement`,
                        suggestion: `${cleanContent};`
                    });
                    tokenIndex++;
                    continue;
                }

                const stmtBody = cleanContent.slice(0, -1).trim();
                const match = stmtBody.match(/^([a-zA-Z_]\w*)\s*\((.*?)\)$/);

                if (!match) {
                    collectedErrors.push({
                        lineNum: lineNum,
                        lineText: token.raw,
                        message: `In line ${lineNum}: Invalid statement syntax structure`,
                        suggestion: `${stmtBody};`
                    });
                    tokenIndex++;
                    continue;
                }

                const commandName = match[1];
                if (!BOT_COMMAND_LIBRARY[commandName]) {
                    let closest = validCommands[0];
                    let minDst = Infinity;
                    validCommands.forEach(vc => {
                        const dst = getLevenshteinDistance(commandName, vc);
                        if (dst < minDst) { minDst = dst; closest = vc; }
                    });
                    collectedErrors.push({
                        lineNum: lineNum,
                        lineText: token.raw,
                        message: `In line ${lineNum}: Use of undeclared or misspelled function '${commandName}'`,
                        suggestion: `${closest}(${match[2]});`
                    });
                    tokenIndex++;
                    continue;
                }

                instructions.push({ type: 'COMMAND', name: commandName });
                tokenIndex++;
            }

            if (!isTopLevel) {
                collectedErrors.push({
                    lineNum: lines.length,
                    lineText: lines[lines.length - 1] || '',
                    message: `Block closure error: Missing closing bracket '}' for code block body`,
                    suggestion: `Add '}' at the end of the block body`
                });
            }

            return instructions;
        };

        const compiledInstructions = parseBlock(true);

        if (collectedErrors.length > 0) {
            throw collectedErrors;
        }

        return compiledInstructions;
    }

    parseAndExecute(scriptString) {
        if (this.taskQueue.length > 0 || this.taskState !== 'IDLE') {
            return;
        }

        clearErrorHighlights();

        try {
            const instructions = this.tokenizeAndCompileScript(scriptString);
            
            if (instructions.length === 0) {
                return;
            }

            this.taskQueue = instructions;
            setRunButtonState(false);
        } catch (errs) {
            console.error(errs);
            setRunButtonState(true);

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
            case BOT_COMMAND_LIBRARY.isBlocked: return this.isBlocked();
        }
    }

    move() {
        const direction = this.getFacingVector();
        const nextX = this.bot.x + direction.x;
        const nextY = this.bot.y + direction.y;
        if (this.isBlocked() || !this.isInBounds(nextX, nextY)) {
            this.setTaskState('BLOCKED');
            this.displayError('ERR: Movement blocked by obstacle/boundary');
            this.taskQueue = [];
            this.setTaskState('IDLE');
            setRunButtonState(true);
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
        return this.lastScanResult;
    }

    update(now = performance.now()) {
        if (this.taskState !== 'IDLE' || this.taskQueue.length === 0) return;
        if (now - this.lastCommandAt < this.commandDelayMs) return;
        
        const nextTask = this.taskQueue[0];
        this.lastCommandAt = now;

        if (nextTask.type === 'COMMAND') {
            this.taskQueue.shift();
            this.executeCommand(nextTask.name);
        } else if (nextTask.type === 'WHILE') {
            const conditionMet = this.evaluateCondition(nextTask.condition);
            if (conditionMet) {
                this.taskQueue.shift();
                this.taskQueue.unshift(...JSON.parse(JSON.stringify(nextTask.body)), nextTask);
            } else {
                this.taskQueue.shift();
            }
        } else if (nextTask.type === 'IF') {
            const conditionMet = this.evaluateCondition(nextTask.condition);
            this.taskQueue.shift();
            const activeBranch = conditionMet ? nextTask.ifBody : nextTask.elseBody;
            if (activeBranch && activeBranch.length > 0) {
                this.taskQueue.unshift(...JSON.parse(JSON.stringify(activeBranch)));
            }
        }

        if (this.taskQueue.length === 0 && this.taskState === 'IDLE') {
            setRunButtonState(true);
        }
    }
}

function setRunButtonState(isInteractive) {
    const btn = document.getElementById('run-script-btn');
    if (!btn) return;
    
    if (isInteractive) {
        btn.removeAttribute('disabled');
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        btn.className = "mt-4 bg-primary-container text-on-primary-container font-code-sm text-code-sm py-3 pixel-border hover:brightness-110 active:shadow-[inset_2px_2px_0px_#000] transition-all flex items-center justify-center gap-2 group";
    } else {
        btn.setAttribute('disabled', 'true');
        btn.style.opacity = '0.65';
        btn.style.cursor = 'not-allowed';
        btn.className = "mt-4 bg-surface-container-high text-on-surface-variant font-code-sm text-code-sm py-3 pixel-border transition-all flex items-center justify-center gap-2 group";
    }
}

function highlightMultipleErrors(errors) {
    const errorSummaries = [];

    errors.forEach(err => {
        const lineNumEl = document.getElementById(`line-num-${err.lineNum}`);
        if (lineNumEl) {
            lineNumEl.style.backgroundColor = '#93000a';
            lineNumEl.style.color = '#ffdad6';
            lineNumEl.style.fontWeight = '700';
        }
        if (err.suggestion) {
            errorSummaries.push(`${err.message} <span style="color: #ffd588;">suggestion: ${err.suggestion}</span>`);
        } else {
            errorSummaries.push(`${err.message}`);
        }
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

    // Crate visual element at (3, 5)
    const crateEl = document.createElement('div');
    crateEl.style.position = 'absolute';
    crateEl.style.width = '32px';
    crateEl.style.height = '32px';
    crateEl.style.backgroundColor = '#f4b41b';
    crateEl.style.left = (3 * 32) + 'px';
    crateEl.style.top = (5 * 32) + 'px';
    crateEl.style.border = '2px solid #ffd588';
    crateEl.style.display = 'flex';
    crateEl.style.alignItems = 'center';
    crateEl.style.justifyContent = 'center';
    crateEl.innerHTML = '<span class="material-symbols-outlined text-xs text-on-primary">box</span>';
    container.appendChild(crateEl);

    // Delivery zone visual element at (7, 5)
    const zoneEl = document.createElement('div');
    zoneEl.style.position = 'absolute';
    zoneEl.style.width = '32px';
    zoneEl.style.height = '32px';
    zoneEl.style.backgroundColor = 'rgba(140, 242, 114, 0.2)';
    zoneEl.style.left = (7 * 32) + 'px';
    zoneEl.style.top = (5 * 32) + 'px';
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

window.botController = new BotController({ commandDelayMs: 400 });
initBotVisualizer(window.botController, 'VIEWPORT_ACTIVE');

function gameLoop() {
    if (window.botController) {
        window.botController.update();
    }
    requestAnimationFrame(gameLoop);
}
gameLoop();