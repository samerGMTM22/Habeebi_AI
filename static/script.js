// === DOM Elements ===
const recordButton = document.getElementById('recordButton');
const voiceSelect = document.getElementById('voiceSelect');
const statusDiv = document.getElementById('status');
const refreshButton = document.getElementById('refreshButton');
const stopButton = document.getElementById('stopButton'); // Get reference to Stop Button
const visualizerCanvas = document.getElementById('visualizer');
const canvasCtx = visualizerCanvas.getContext('2d');

// === State Variables ===
let mediaRecorder;
let localAudioChunks = [];
let ws;
let audioContext;
let audioQueue = [];
let currentAudioSource = null; // Keep track of the currently playing source node
let isPlaying = false;
let nextStartTime = 0;
let analyser;
let sourceNode; // For connecting analyser during recording
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
    // Stop button is now always visible due to CSS change
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
                // No longer hiding stop button here - it's always visible
            }
            break;
        case 'error':
            console.error('Server error:', message.message);
            statusDiv.textContent = `Server Error: ${message.message}`;
            isPlaying = false;
            audioQueue = [];
            nextStartTime = 0;
            // No longer hiding stop button here - it's always visible
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

    // Only proceed if the queue has items and we are not already playing.
    if (audioQueue.length === 0 || isPlaying) {
        if (audioQueue.length === 0 && !isPlaying) {
            console.log("playAudioQueue: Queue is empty, ensuring UI is reset.");
            statusDiv.textContent = 'Ready. Hold button to speak.';
            // No longer hiding stop button here - it's always visible
            if (isReady) { // Re-enable buttons if agent is ready
                 recordButton.disabled = false;
                 refreshButton.disabled = false;
            }
            nextStartTime = 0;
        }
        return; // Exit if queue empty or already playing
    }

    // --- Start playing the next chunk ---
    isPlaying = true; // Set playing flag
    // No longer showing stop button here - it's always visible
    recordButton.disabled = true; // Disable other buttons during playback
    refreshButton.disabled = true;
    statusDiv.textContent = 'Assistant speaking...';
    const audioChunkArrayBuffer = audioQueue.shift(); // Get the next chunk

    try {
        // --- Decode and Prepare Buffer ---
        if (audioChunkArrayBuffer.byteLength % 2 !== 0) {
            console.error("Received audio data with odd byte length, cannot process as Int16.");
            isPlaying = false; // Reset flag
            playAudioQueue(); // Try next chunk immediately
            return;
        }
        const pcm16Data = new Int16Array(audioChunkArrayBuffer);
        const pcm32Data = new Float32Array(pcm16Data.length);
        for (let i = 0; i < pcm16Data.length; i++) {
            pcm32Data[i] = pcm16Data[i] / 32768.0;
        }
        const audioBuffer = audioContext.createBuffer(1, pcm32Data.length, audioContext.sampleRate);
        audioBuffer.copyToChannel(pcm32Data, 0);

        // --- Schedule Playback ---
        currentAudioSource = audioContext.createBufferSource(); // Store reference
        currentAudioSource.buffer = audioBuffer;
        currentAudioSource.connect(audioContext.destination);
        const currentTime = audioContext.currentTime;
        const startTime = Math.max(currentTime, nextStartTime);
        currentAudioSource.start(startTime);
        nextStartTime = startTime + audioBuffer.duration;

        // --- Handle Chunk End ---
        currentAudioSource.onended = () => {
            currentAudioSource = null; // Clear reference
            // This chunk finished playing.
            currentAudioSource = null; // Clear reference
            isPlaying = false; // Allow next chunk to be processed
            // Immediately attempt to play the next chunk.
            // The check at the start of playAudioQueue will handle the empty queue case.
            playAudioQueue();
        };

    } catch (error) {
        console.error("Error decoding or playing audio chunk:", error);
        audioQueue = []; // Clear queue on error
        isPlaying = false;
        nextStartTime = 0;
        // No longer hiding stop button here - it's always visible
        if (isReady) { // Only re-enable if agent is ready
             recordButton.disabled = false;
             refreshButton.disabled = false;
        }
        statusDiv.textContent = `Error playing audio: ${error.message}`;
    }
}

// Function to stop audio playback and signal agent stop
function stopAgentAndPlayback() {
    console.log("Stopping playback and signaling agent stop...");

    // 1. Stop local audio playback
    audioQueue = []; // Clear the queue of pending chunks
    if (currentAudioSource) {
        currentAudioSource.onended = null; // Prevent the onended callback from firing
        try {
            currentAudioSource.stop(); // Stop the currently playing buffer source
        } catch (e) {
            console.warn("Error stopping audio source (might have already stopped):", e);
        }
        currentAudioSource = null;
    }
    isPlaying = false;
    nextStartTime = 0;

    // 2. Send stop signal to backend via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("Sending stop_agent command to backend.");
        ws.send(JSON.stringify({ command: 'stop_agent' }));
    } else {
        console.warn("WebSocket not open, cannot send stop_agent command.");
    }

    // 3. Update UI
    // No longer hiding stop button here - it's always visible
    statusDiv.textContent = 'Agent stop requested. Ready.';
    if (isReady) { // Only re-enable if agent is ready
        recordButton.disabled = false;
        refreshButton.disabled = false;
    } else {
        // If agent wasn't ready, keep buttons disabled
        recordButton.disabled = true;
        refreshButton.disabled = true;
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
                // No longer showing stop button here - it's always visible
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

    // Add event listener for the stop button
    stopButton.addEventListener('click', stopAgentAndPlayback); // Updated function call

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

let visualizerDrawing = false; // Flag to prevent multiple animation frame loops

// Draws frequency bars visualization
function drawVisualizer() {
    // Ensure analyser exists and the loop isn't already running.
    if (!analyser || visualizerDrawing) return;
    visualizerDrawing = true; // Set flag to indicate loop is active.

    // Get the analyser's configuration.
    // analyser.fftSize = 256; // Smaller FFT size for fewer, wider bars (optional)
    const bufferLength = analyser.frequencyBinCount; // Number of data points (half of fftSize).
    // Create an array to hold the frequency data.
    const dataArray = new Uint8Array(bufferLength);

    // --- Animation Loop ---
    function draw() {
        // Stop the loop if the source node has been disconnected.
        if (!sourceNode) {
             visualizerDrawing = false; // Reset flag.
             // Clear canvas one last time
             canvasCtx.fillStyle = 'rgb(42, 42, 42)'; // Match canvas background
             canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
             return;
        }
        // Request the next frame for animation.
        requestAnimationFrame(draw);

        // Get the current frequency data from the analyser.
        analyser.getByteFrequencyData(dataArray);

        // --- Drawing on Canvas ---
        // Clear the canvas with the background color.
        canvasCtx.fillStyle = '#2a2a2a'; // Match canvas background from CSS
        canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

        const barWidth = (visualizerCanvas.width / bufferLength) * 1.5; // Width of each bar (adjust multiplier for spacing)
        let barHeight;
        let x = 0; // Current horizontal position.

        // Iterate through the frequency data points.
        for (let i = 0; i < bufferLength; i++) {
            // Scale the data point (0-255) to the canvas height.
            barHeight = dataArray[i] * (visualizerCanvas.height / 255); // Scale to canvas height

            // Set the color for the bars (e.g., a blue gradient based on height)
            const blueIntensity = Math.min(255, barHeight * 2); // More intense blue for taller bars
            canvasCtx.fillStyle = `rgb(0, ${150 + blueIntensity / 3}, ${blueIntensity})`; // Adjust green/blue mix

            // Draw the bar. Starts from bottom (canvas height) and goes upwards.
            canvasCtx.fillRect(
                x,                          // Horizontal position
                visualizerCanvas.height - barHeight, // Vertical start (bottom minus height)
                barWidth,                   // Bar width
                barHeight                   // Bar height
            );

            // Move to the position for the next bar (including spacing).
            x += barWidth + 1; // Add 1 for spacing between bars
        }
    } // End of inner draw function
    // Start the animation loop.
    draw();
} // End of drawVisualizer

// === Start Initialization ===
initialize();
