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

// --- CLASS: The Controller ---
class BotController {
    constructor(options = {}) {
        this.bot = options.bot || { x: 0, y: 0, orientationIndex: 0 };
        this.scene = options.scene || null;
        this.gridWidth = options.gridWidth || 10;
        this.gridHeight = options.gridHeight || 10;
        this.gridSize = options.gridSize || 32;

        this.worldObjects = new Map(options.worldObjects || []);
        this.deliveryZones = new Set(options.deliveryZones || []);
        this.collisionObjects = new Set(options.collisionObjects || []);

        this.taskQueue = [];
        this.taskState = 'IDLE';
        this.inventory = 'empty';
        this.lastScanResult = 'empty';
        this.gold = options.gold || 0;
        this.commandDelayMs = options.commandDelayMs || 120;
        this.lastCommandAt = 0;

        this.onGoldGain = options.onGoldGain || null;
        this.onStateChange = options.onStateChange || null;
    }

    static get COMMAND_LIBRARY() { return BOT_COMMAND_LIBRARY; }

    getFacingVector() { return BOT_DIRECTIONS[this.bot.orientationIndex % BOT_DIRECTIONS.length]; }

    setTaskState(nextState) {
        this.taskState = nextState;
        if (typeof this.onStateChange === 'function') this.onStateChange(nextState);
    }

    toTileKey(x, y) { return `${x},${y}`; }

    getFrontTile() {
        const direction = this.getFacingVector();
        return { x: this.bot.x + direction.x, y: this.bot.y + direction.y };
    }

    isInBounds(x, y) { return x >= 0 && y >= 0 && x < this.gridWidth && y < this.gridHeight; }

    isBlocked(x, y) {
        const key = this.toTileKey(x, y);
        return !this.isInBounds(x, y) || this.collisionObjects.has(key) || this.worldObjects.has(key);
    }

    queueCommand(commandName) {
        const task = { name: commandName, payload: null };
        this.taskQueue.push(task);
        return task;
    }

    tokenizeScript(scriptString) {
        const commands = [];
        const cleaned = scriptString.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return commands;

        const tokenPattern = /([a-zA-Z_]+)\s*\(/g;
        let match;
        while ((match = tokenPattern.exec(cleaned)) !== null) {
            const commandName = match[1];
            if (!Object.prototype.hasOwnProperty.call(BOT_COMMAND_LIBRARY, commandName)) {
                throw new Error(`Unsupported command: ${commandName}`);
            }
            commands.push(commandName);
        }
        return commands;
    }

    parseAndExecute(scriptString) {
        const commandNames = this.tokenizeScript(scriptString);
        return commandNames.map((commandName) => this.queueCommand(commandName));
    }

    executeCommand(commandName) {
        switch (commandName) {
            case BOT_COMMAND_LIBRARY.move: return this.move();
            case BOT_COMMAND_LIBRARY.turnLeft: return this.turnLeft();
            case BOT_COMMAND_LIBRARY.turnRight: return this.turnRight();
            case BOT_COMMAND_LIBRARY.pickup: return this.pickup();
            case BOT_COMMAND_LIBRARY.dropoff: return this.dropoff();
            case BOT_COMMAND_LIBRARY.scan: return this.scan();
            default: throw new Error(`Command not implemented: ${commandName}`);
        }
    }

    move() {
        const direction = this.getFacingVector();
        const nextX = this.bot.x + direction.x;
        const nextY = this.bot.y + direction.y;
        if (this.isBlocked(nextX, nextY)) {
            this.setTaskState('BLOCKED');
            return { completed: true, status: 'blocked' };
        }
        this.setTaskState('MOVING');
        this.bot.x = nextX;
        this.bot.y = nextY;
        this.setTaskState('IDLE');
        return { completed: true, status: 'moved' };
    }

    turnLeft() {
        this.setTaskState('TURNING');
        this.bot.orientationIndex = (this.bot.orientationIndex + 3) % BOT_DIRECTIONS.length;
        this.setTaskState('IDLE');
        return { completed: true, status: 'turned_left' };
    }

    turnRight() {
        this.setTaskState('TURNING');
        this.bot.orientationIndex = (this.bot.orientationIndex + 1) % BOT_DIRECTIONS.length;
        this.setTaskState('IDLE');
        return { completed: true, status: 'turned_right' };
    }

    pickup() {
        this.setTaskState('PICKUP');
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        if (this.worldObjects.get(key) === 'crate') this.inventory = 'full';
        this.setTaskState('IDLE');
        return { completed: true, inventory: this.inventory, tile: key };
    }

    dropoff() {
        this.setTaskState('DROPOFF');
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        if (this.deliveryZones.has(key) && this.inventory === 'full') {
            this.inventory = 'empty';
            this.gold += 50;
        }
        this.setTaskState('IDLE');
        return { completed: true, inventory: this.inventory, gold: this.gold, tile: key };
    }

    scan() {
        this.setTaskState('SCANNING');
        const front = this.getFrontTile();
        const key = this.toTileKey(front.x, front.y);
        const tileType = this.worldObjects.get(key) || (this.deliveryZones.has(key) ? 'delivery_zone' : 'empty');
        this.lastScanResult = tileType;
        this.setTaskState('IDLE');
        return { completed: true, tile: key, result: tileType };
    }

    update(now = performance.now()) {
        if (this.taskState !== 'IDLE' || this.taskQueue.length === 0) return null;
        if (now - this.lastCommandAt < this.commandDelayMs) return null;
        const nextTask = this.taskQueue.shift();
        this.lastCommandAt = now;
        return this.executeCommand(nextTask.name);
    }
}

// --- VISUALIZER: Adds visibility to the bot ---
function initBotVisualizer(controller, containerId = null) {
    const botElement = document.createElement('div');
    botElement.style.position = 'absolute';
    botElement.style.width = controller.gridSize + 'px';
    botElement.style.height = controller.gridSize + 'px';
    botElement.style.backgroundColor = '#FFD700'; 
    botElement.style.borderRadius = '50%';
    botElement.style.zIndex = '1000';
    botElement.style.transition = 'all 0.1s linear';
    
    const container = containerId ? document.getElementById(containerId) : document.body;
    container.appendChild(botElement);

    function updateVisuals() {
        const x = controller.bot.x * controller.gridSize;
        const y = controller.bot.y * controller.gridSize;
        botElement.style.left = x + 'px';
        botElement.style.top = y + 'px';
        requestAnimationFrame(updateVisuals);
    }
    updateVisuals();
}

window.BotController = BotController;
window.initBotVisualizer = initBotVisualizer;