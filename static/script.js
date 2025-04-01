const recordButton = document.getElementById('recordButton');
const voiceSelect = document.getElementById('voiceSelect');
const statusDiv = document.getElementById('status');
// No need for audioPlaybackElement

let mediaRecorder;
let audioChunks = [];
let audioContext; // Keep AudioContext global
let currentSourceNode = null; // Keep track of the currently playing source

// --- Recording Logic ---

// --- Recording Logic ---

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // --- MODIFICATION START ---
        // Try requesting WAV format specifically
        const options = { mimeType: 'audio/wav' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn('Browser does not support audio/wav, trying default recorder format.');
            // Fallback to browser default if WAV is not supported
            options.mimeType = ''; // Empty string lets the browser pick
        }
        console.log(`Using MediaRecorder with options: ${JSON.stringify(options)}`);
        mediaRecorder = new MediaRecorder(stream, options);
        // --- MODIFICATION END ---


        mediaRecorder.ondataavailable = event => {
            audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            statusDiv.textContent = 'Processing...';

            // --- MODIFICATION START ---
            // Ensure the Blob type matches what the recorder actually used
            const blobMimeType = mediaRecorder.mimeType || 'audio/wav'; // Use actual or desired
            console.log(`Creating Blob with type: ${blobMimeType}`);
            const audioBlob = new Blob(audioChunks, { type: blobMimeType });
             // --- MODIFICATION END ---

            // Send audio to backend
            await sendAudioToServer(audioBlob);

            // Clear chunks for next recording
            audioChunks = [];
            // Release microphone track
            stream.getTracks().forEach(track => track.stop());
        };

        audioChunks = []; // Clear previous chunks
        mediaRecorder.start();
        statusDiv.textContent = 'Recording... Release to send.';

    } catch (err) {
        console.error("Error accessing microphone:", err);
        statusDiv.textContent = `Error: ${err.message}. Check mic permissions.`;
    }
}

// --- Keep other functions (stopRecording, sendAudioToServer, playAudio) and event listeners the same ---
// ... (rest of the script.js code from the previous step) ...

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
}

// --- Sending and Playback Logic ---

async function sendAudioToServer(audioBlob) {
    const formData = new FormData();
    formData.append('audio_data', audioBlob, 'recording.wav'); // Filename matters less now
    formData.append('voice', voiceSelect.value);

    try {
        statusDiv.textContent = 'Processing...'; // Set status before sending
        const response = await fetch('/process-voice', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Server error: ${errorData.error || response.statusText}`);
        }

        // --- MODIFICATION START: Handle WAV Blob ---
        console.log("Received audio response from server.");
        statusDiv.textContent = 'Playing response...';

        // Get response audio data as a Blob (expecting audio/wav)
        const wavBlob = await response.blob();
        console.log(`Received Blob type: ${wavBlob.type}, size: ${wavBlob.size}`);

        if (wavBlob.size < 44) { // Basic check for empty WAV header
             console.error("Received empty or invalid WAV data.");
             statusDiv.textContent = 'Ready. (Received empty audio response).';
             return;
        }

        // Play the received WAV blob using the <audio> element
        await playAudioBlob(wavBlob);

        // Status updated within playAudioBlob's 'ended' event listener
        // --- MODIFICATION END ---

    } catch (err) {
        console.error("Error sending/receiving audio:", err);
        statusDiv.textContent = `Error: ${err.message}`;
    }
}

// In static/script.js

// --- Playback Logic (Replaced playAudio with playAudioBlob) ---
async function playAudioBlob(wavBlob) {
    const url = URL.createObjectURL(wavBlob);
    console.log("playAudioBlob (Simple): Created object URL:", url);

    const audioElement = new Audio(); // Create dynamically

    // Add listeners *before* setting src
    const removeListeners = () => {
        audioElement.removeEventListener('ended', onPlayEnd);
        audioElement.removeEventListener('error', onPlayError);
        console.log("playAudioBlob (Simple): Listeners removed.");
    }

    const onPlayEnd = () => {
        console.log("playAudioBlob (Simple): Playback finished (audio element 'ended' event).");
        statusDiv.textContent = 'Ready. Press and hold the button to speak.';
        URL.revokeObjectURL(url);
        removeListeners();
    };

    const onPlayError = (err) => {
        console.error("playAudioBlob (Simple): Error playing audio element event:", err);
        let errorDetails = "Unknown playback error";
        if (audioElement.error) {
            switch (audioElement.error.code) {
              case MediaError.MEDIA_ERR_ABORTED: errorDetails = 'Playback aborted.'; break;
              case MediaError.MEDIA_ERR_NETWORK: errorDetails = 'Network error.'; break;
              case MediaError.MEDIA_ERR_DECODE: errorDetails = 'Audio decoding error.'; break;
              case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: errorDetails = 'Audio format not supported.'; break;
              default: errorDetails = `Unknown error (code ${audioElement.error.code})`;
            }
        } else if (err && err.message) {
             errorDetails = err.message;
        }
        console.error("playAudioBlob (Simple): Detailed Error:", errorDetails);
        statusDiv.textContent = `Error playing audio: ${errorDetails}`;
        URL.revokeObjectURL(url);
        removeListeners();
    };

    audioElement.addEventListener('ended', onPlayEnd);
    audioElement.addEventListener('error', onPlayError);

    // Set src and try playing immediately
    audioElement.src = url;
    // audioElement.load(); // Often not needed

    console.log("playAudioBlob (Simple): src set. Attempting to play...");

    try {
        // The play() method returns a promise
        await audioElement.play();
        console.log("playAudioBlob (Simple): .play() promise resolved (playback likely started).");
        // Status is updated by 'onended' listener
    } catch (error) {
         // Catch errors from the play() promise itself
         console.error("playAudioBlob (Simple): .play() promise rejected:");
         onPlayError(error); // Handle error using the common handler
    }
}

// --- Event Listeners ---
recordButton.addEventListener('mousedown', startRecording);
recordButton.addEventListener('mouseup', stopRecording);
// Also handle leaving the button area while pressing
recordButton.addEventListener('mouseleave', stopRecording);

console.log("UI Initialized. Hold button to speak.");