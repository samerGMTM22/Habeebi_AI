// === DOM Elements ===
const recordButton = document.getElementById('recordButton');
const voiceSelect = document.getElementById('voiceSelect');
const statusDiv = document.getElementById('status');
const refreshButton = document.getElementById('refreshButton');
const visualizerCanvas = document.getElementById('visualizer');
const canvasCtx = visualizerCanvas.getContext('2d');

// === State Variables ===
let mediaRecorder;
let localAudioChunks = [];
let ws;
let audioContext;
let audioQueue = [];
let isPlaying = false;
let nextStartTime = 0;
let analyser;
let sourceNode;
let micStream;
let isReady = false;

// === Constants ===
const TARGET_SAMPLE_RATE = 24000;
const WS_URL = `ws://${window.location.host}/ws`;

// === Initialization ===
function initialize() {
    console.log("Initializing UI and WebSocket...");
    setupWebSocket();
    setupAudioPlayback();
    setupEventListeners();
    setupVisualizer();
}

// === WebSocket Setup ===
function setupWebSocket() {
    console.log(`Attempting to connect to WebSocket: ${WS_URL}`);
    ws = new WebSocket(WS_URL);
    // Explicitly set the binary type to receive ArrayBuffer directly
    ws.binaryType = "arraybuffer";

    ws.onopen = (event) => {
        console.log('WebSocket connection opened:', event);
        statusDiv.textContent = 'Connected. Waiting for agent...';
    };

    ws.onclose = (event) => {
        console.log('WebSocket connection closed:', event);
        statusDiv.textContent = `Disconnected: ${event.reason || 'No reason given'}. Please refresh.`;
        recordButton.disabled = true;
        refreshButton.disabled = true;
        isReady = false;
    };

    ws.onerror = (event) => {
        console.error('WebSocket error:', event);
        statusDiv.textContent = 'WebSocket connection error. Please refresh.';
        recordButton.disabled = true;
        refreshButton.disabled = true;
        isReady = false;
    };

    ws.onmessage = (event) => {
        console.log("ws.onmessage received data:", event.data);
        console.log("Type:", typeof event.data);

        if (event.data instanceof ArrayBuffer) {
            console.log(`Received ArrayBuffer, byteLength: ${event.data.byteLength}`);
            audioQueue.push(event.data);
            if (!isPlaying && audioQueue.length > 0) {
                 ensureAudioContext().then(ready => {
                    if (ready && !isPlaying && audioQueue.length > 0) {
                       playAudioQueue();
                    }
                 });
            }
        } else if (typeof event.data === 'string') {
            console.log(`Received string data: "${event.data}"`);
            try {
                const message = JSON.parse(event.data);
                handleServerMessage(message);
            } catch (e) {
                console.error('Failed to parse JSON message:', event.data, e);
            }
        // Removed Blob handling block as binaryType is set to arraybuffer
        } else {
            console.warn("Received unexpected data type:", typeof event.data, event.data);
        }
    };
}

// === Handle JSON Messages from Server ===
function handleServerMessage(message) {
    switch (message.type) {
        case 'status':
            statusDiv.textContent = message.message;
            if (message.message === 'Agent ready') {
                isReady = true;
                recordButton.disabled = false;
                refreshButton.disabled = false;
            }
            break;
        case 'error':
            console.error('Server error:', message.message);
            statusDiv.textContent = `Server Error: ${message.message}`;
            isPlaying = false;
            audioQueue = [];
            nextStartTime = 0;
            recordButton.disabled = !isReady;
            refreshButton.disabled = !isReady;
            break;
        case 'audio_stream_end':
            console.log('Audio stream ended signal received.');
            break;
        case 'zapier_refreshed':
            console.log('Zapier refresh status:', message.status);
            statusDiv.textContent = `Zapier Refresh: ${message.status}`;
            isReady = (message.status === 'success');
            refreshButton.disabled = false;
            recordButton.disabled = !isReady;
             if (isReady) {
                 setTimeout(() => {
                     if (statusDiv.textContent.startsWith('Zapier Refresh:')) {
                        statusDiv.textContent = 'Ready. Hold button to speak.';
                     }
                 }, 2000);
             }
            break;
        case 'lifecycle':
             console.log(`Agent Lifecycle: ${message.event}`);
             break;
        default:
            console.warn('Received unknown message type:', message.type);
    }
}

// === Audio Playback Setup (Web Audio API) ===
function setupAudioPlayback() {
    console.log("Audio playback setup (Context creation deferred).");
}

async function ensureAudioContext() {
    if (!audioContext) {
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: TARGET_SAMPLE_RATE
            });
            console.log(`AudioContext created with sample rate: ${audioContext.sampleRate} Hz`);
             if (audioContext.sampleRate !== TARGET_SAMPLE_RATE) {
                console.warn(`AudioContext running at ${audioContext.sampleRate}Hz, but TTS is ${TARGET_SAMPLE_RATE}Hz. Quality might be affected.`);
            }
        } catch (e) {
            console.error("Web Audio API is not supported in this browser", e);
            statusDiv.textContent = "Error: Web Audio API not supported.";
            recordButton.disabled = true;
            refreshButton.disabled = true;
            return false;
        }
    }
    if (audioContext.state === 'suspended') {
        console.log("Resuming suspended AudioContext...");
        await audioContext.resume();
    }
    return true;
}

// === Audio Playback Logic ===
async function playAudioQueue() {
    // Ensure AudioContext is ready before proceeding.
    if (!await ensureAudioContext()) return;

    // If the queue is empty OR playback is already in progress, exit.
    // The `onended` handler of the currently playing chunk will call this again.
    if (audioQueue.length === 0 || isPlaying) {
        if (audioQueue.length === 0 && !isPlaying) {
             console.log("Playback queue empty and not currently playing.");
        }
        return;
    }

    // Set the flag *before* processing the chunk to prevent race conditions.
    isPlaying = true;
    statusDiv.textContent = 'Assistant speaking...';

    // Get the next chunk (ArrayBuffer) from the queue.
    const audioChunkArrayBuffer = audioQueue.shift();

    try {
        // --- Decode and Prepare Buffer ---
        // Verify data integrity (byte length must be even for Int16).
        if (audioChunkArrayBuffer.byteLength % 2 !== 0) {
            console.error("Received audio data with odd byte length, cannot process as Int16.");
            isPlaying = false; // Reset flag
            playAudioQueue(); // Try next chunk immediately
            return;
        }
        // Convert raw bytes to Float32 data for Web Audio API.
        const pcm16Data = new Int16Array(audioChunkArrayBuffer);
        const pcm32Data = new Float32Array(pcm16Data.length);
        for (let i = 0; i < pcm16Data.length; i++) {
            pcm32Data[i] = pcm16Data[i] / 32768.0; // Normalize Int16 to [-1.0, 1.0]
        }
        // Create an AudioBuffer.
        const audioBuffer = audioContext.createBuffer(1, pcm32Data.length, audioContext.sampleRate);
        audioBuffer.copyToChannel(pcm32Data, 0);

        // --- Schedule Playback ---
        // Create a source node for this buffer.
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination); // Connect to speakers.

        // Calculate precise start time for gapless playback.
        const currentTime = audioContext.currentTime;
        const startTime = Math.max(currentTime, nextStartTime); // Start now or after previous chunk.

        // Schedule playback.
        source.start(startTime);
        // Update the start time for the *next* chunk.
        nextStartTime = startTime + audioBuffer.duration;

        // --- Handle Chunk End ---
        // This function is called when *this specific chunk* finishes playing.
        source.onended = () => {
            // Important: Reset the isPlaying flag *before* calling playAudioQueue again.
            // This allows the next call to proceed if there are more chunks.
            isPlaying = false;
            // Check if more chunks are available and trigger the next playback.
            if (audioQueue.length > 0) {
                playAudioQueue();
            } else {
                // This was the last chunk, and the queue is now empty.
                console.log("Finished playing last audio chunk.");
                statusDiv.textContent = 'Ready. Hold button to speak.';
                nextStartTime = 0; // Reset scheduling time.
            }
        };

    } catch (error) {
        // Handle errors during audio processing/playback.
        console.error("Error decoding or playing audio chunk:", error);
        audioQueue = []; // Clear the queue on error.
        isPlaying = false;
        nextStartTime = 0;
        statusDiv.textContent = `Error playing audio: ${error.message}`;
    }
}

// === Recording Logic ===
async function startRecording() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !isReady) {
        console.error("WebSocket not connected or agent not ready.");
        statusDiv.textContent = "Not connected or agent not ready.";
        return;
    }
     if (!await ensureAudioContext()) return;

    localAudioChunks = [];
    audioQueue = [];
    isPlaying = false;
    nextStartTime = 0;

    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        connectVisualizer(micStream);

        const options = { mimeType: 'audio/webm' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn('Browser does not support audio/webm, trying default.');
            options.mimeType = '';
        }
        mediaRecorder = new MediaRecorder(micStream, options);

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) {
                localAudioChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            statusDiv.textContent = 'Processing...';
            disconnectVisualizer();

            if (localAudioChunks.length === 0) {
                console.warn("No audio data recorded.");
                statusDiv.textContent = 'Ready. (No audio recorded).';
                recordButton.disabled = false;
                return;
            }

            const blobMimeType = mediaRecorder.mimeType || 'audio/webm';
            const audioBlob = new Blob(localAudioChunks, { type: blobMimeType });
            const arrayBuffer = await audioBlob.arrayBuffer();

            console.log(`Sending audio (${arrayBuffer.byteLength} bytes) via WebSocket...`);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(arrayBuffer);
            } else {
                 console.error("WebSocket closed before sending audio.");
                 statusDiv.textContent = "Connection lost before sending.";
            }
            localAudioChunks = [];
        };

        mediaRecorder.start(100);
        statusDiv.textContent = 'Recording... Release to send.';
        recordButton.disabled = true;

    } catch (err) {
        console.error("Error accessing microphone:", err);
        statusDiv.textContent = `Error: ${err.message}. Check mic permissions.`;
        disconnectVisualizer();
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        recordButton.disabled = false;
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
            micStream = null;
        }
    }
}

// === Event Listeners ===
function setupEventListeners() {
    recordButton.addEventListener('mousedown', startRecording);
    recordButton.addEventListener('mouseup', stopRecording);
    recordButton.addEventListener('mouseleave', stopRecording);

    refreshButton.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log("Requesting Zapier refresh via WebSocket...");
            statusDiv.textContent = 'Requesting Zapier refresh...';
            ws.send(JSON.stringify({ command: 'refresh_zapier' }));
            refreshButton.disabled = true;
            recordButton.disabled = true;
        } else {
            console.error("WebSocket not connected, cannot refresh.");
            statusDiv.textContent = "Not connected.";
        }
    });
}

// === Audio Visualization ===
function setupVisualizer() {
    console.log("Visualizer setup (Analyser creation deferred).");
}

async function connectVisualizer(stream) {
    if (!await ensureAudioContext() || !stream) return;
    if (!analyser) {
         analyser = audioContext.createAnalyser();
         analyser.fftSize = 2048;
    }
    try {
        sourceNode = audioContext.createMediaStreamSource(stream);
        sourceNode.connect(analyser);
        console.log("Visualizer connected to mic stream.");
        if (!visualizerDrawing) drawVisualizer();
    } catch (error) {
        console.error("Error connecting visualizer:", error);
    }
}

function disconnectVisualizer() {
     if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
        console.log("Visualizer disconnected.");
    }
     canvasCtx.fillStyle = 'rgb(240, 240, 240)';
     canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
}

let visualizerDrawing = false;
function drawVisualizer() {
    if (!analyser || visualizerDrawing) return;
    visualizerDrawing = true;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
        if (!sourceNode) {
             visualizerDrawing = false;
             return;
        }
        requestAnimationFrame(draw);
        analyser.getByteTimeDomainData(dataArray);
        canvasCtx.fillStyle = 'rgb(240, 240, 240)';
        canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = 'rgb(0, 123, 255)';
        canvasCtx.beginPath();
        const sliceWidth = visualizerCanvas.width * 1.0 / bufferLength;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
            const v = dataArray[i] / 128.0;
            const y = v * visualizerCanvas.height / 2;
            if (i === 0) canvasCtx.moveTo(x, y);
            else canvasCtx.lineTo(x, y);
            x += sliceWidth;
        }
        canvasCtx.lineTo(visualizerCanvas.width, visualizerCanvas.height / 2);
        canvasCtx.stroke();
    }
    draw();
}

// === Start Initialization ===
initialize();
