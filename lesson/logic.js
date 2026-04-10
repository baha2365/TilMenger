import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeClickable, setTranslationLanguage } from './translator.js';

// ── Optional: change translation language here ──
// setTranslationLanguage("Kazakh");   // default is Russian

// 1. Scene & Camera Setup
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(3, 7, 4);

// Read topic from URL
const urlParams = new URLSearchParams(window.location.search);
const selectedTopic = urlParams.get("topic");

if (selectedTopic) {
    document.getElementById("topicTitle").innerText = "Topic: " + selectedTopic;
}

/* ─── Bubble helpers ──────────────────────────────────────────── */

const chatDiv = document.getElementById("chat");

/**
 * Append a chat bubble.
 * @param {"user"|"assistant"|"topic"|"suggestion"} role
 * @param {string} text  HTML content
 * @returns {HTMLElement}  the bubble element
 */
function addBubble(role, text = "") {
    const bubble = document.createElement("div");
    bubble.classList.add("bubble");

    if (role === "user")            bubble.classList.add("bubble-user");
    else if (role === "topic")      bubble.classList.add("bubble-topic");
    else if (role === "suggestion") bubble.classList.add("bubble-suggestion");
    else                            bubble.classList.add("bubble-assistant");

    bubble.innerHTML = text;
    chatDiv.appendChild(bubble);
    chatDiv.scrollTop = chatDiv.scrollHeight;
    return bubble;
}

/* ─── Suggestion feature ──────────────────────────────────────── */

/**
 * Call /suggest and, if grammar mistakes exist, insert a 💡 suggestion
 * bubble BEFORE anchorElement (the assistant bubble placeholder).
 */
async function insertSuggestion(userMessage, anchorElement) {
    try {
        const res  = await fetch("http://localhost:8000/suggest", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ message: userMessage }),
        });
        const data = await res.json();

        if (!data.correct && data.corrected) {
            // Wrapper: 💡 icon centred above the bubble
            const wrapper = document.createElement("div");
            wrapper.style.cssText = "display:flex; flex-direction:column; align-items:center; gap:4px;";

            const icon = document.createElement("div");
            icon.textContent = "💡";
            icon.style.cssText = "font-size:18px;";

            const bubble = document.createElement("div");
            bubble.classList.add("bubble", "bubble-suggestion");
            bubble.innerHTML = data.corrected;

            wrapper.appendChild(icon);
            wrapper.appendChild(bubble);

            // Place it between the user bubble and the assistant bubble
            chatDiv.insertBefore(wrapper, anchorElement);
            chatDiv.scrollTop = chatDiv.scrollHeight;
        }
    } catch (e) {
        console.warn("[suggest] error:", e);
    }
}

/* ─── Topic Conversation ──────────────────────────────────────── */

async function startTopicConversation(topic) {
    const starterMessage = `Let's practice English conversation about ${topic}. Ask me simple questions about this topic.`;

    addBubble("topic", `📌 Topic: <b>${topic}</b>`);

    const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: starterMessage })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";

    const bubble = addBubble("assistant");

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkText = decoder.decode(value);
        const lines = chunkText.split("\n").filter(l => l.trim() !== "");

        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.message?.content) {
                    result += obj.message.content;
                    bubble.innerHTML = result;
                    chatDiv.scrollTop = chatDiv.scrollHeight;
                }
            } catch(e) {}
        }
    }

    makeClickable(chatDiv);
}

/* ─── Animation ──────────────────────────────────────────────── */

let mixer;
let animations = [];
let activeAction;
let idleAction;

// 2. Renderer Setup
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

// 3. Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 1);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
directionalLight.position.set(5, 5, 5);
scene.add(directionalLight);

// 4. Load GLB
const loader = new GLTFLoader();
loader.load(
    '../game_girl.glb',
    (gltf) => {
        const model = gltf.scene;
        scene.add(model);

        mixer = new THREE.AnimationMixer(model);
        animations = gltf.animations;

        idleAction = mixer.clipAction(animations[2]);
        idleAction.play();
        activeAction = idleAction;

        mixer.addEventListener('finished', () => { fadeToIdle(); });

        console.log("Model loaded successfully!");
    },
    (xhr) => console.log((xhr.loaded / xhr.total * 100) + '% loaded'),
    (error) => console.error('Error loading model:', error)
);

// 5. Resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

function playAnimation(index) {
    if (!mixer || animations.length === 0) return;
    const newAction = mixer.clipAction(animations[index]);
    if (activeAction !== newAction) {
        newAction.reset();
        newAction.setLoop(THREE.LoopOnce);
        newAction.clampWhenFinished = true;
        newAction.fadeIn(0.3).play();
        activeAction.fadeOut(0.3);
        activeAction = newAction;
    }
}

function fadeToIdle() {
    if (!idleAction) return;
    idleAction.reset();
    idleAction.fadeIn(0.3).play();
    activeAction.fadeOut(0.3);
    activeAction = idleAction;
}

// 6. Render loop
const clock = new THREE.Clock();
function animate() {
    requestAnimationFrame(animate);
    if (mixer) mixer.update(clock.getDelta());
    renderer.render(scene, camera);
}
animate();

/* ─── Chat UI ─────────────────────────────────────────────────── */

const sendBtn = document.getElementById("sendBtn");
const input   = document.getElementById("userInput");

sendBtn.addEventListener("click", sendMessage);
input.addEventListener("keypress", (e) => { if (e.key === "Enter") sendMessage(); });

async function sendMessage() {
    const message = input.value.trim();
    if (!message) return;

    // User bubble — LEFT side
    addBubble("user", message);
    input.value = "";

    // Assistant bubble placeholder — RIGHT side (updated while streaming)
    const assistantBubble = addBubble("assistant");

    // Fire suggestion check in parallel with the chat request.
    // It will inject a 💡 bubble before assistantBubble if mistakes are found.
    insertSuggestion(message, assistantBubble);

    const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
    });

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let result    = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        const lines = chunkText.split("\n").filter(l => l.trim() !== "");

        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.message?.content) {
                    result += obj.message.content;
                    playAnimation(0);

                    // Try to parse JSON vocabulary response
                    try {
                        const jsonStart = result.indexOf("{");
                        const jsonEnd   = result.lastIndexOf("}");

                        if (jsonStart !== -1 && jsonEnd !== -1) {
                            const jsonString = result.substring(jsonStart, jsonEnd + 1);
                            const parsed     = JSON.parse(jsonString);

                            if (parsed.main_word) {
                                document.getElementById("mainWordBox").style.display = "block";
                                document.getElementById("mainWordBox").innerText     = parsed.main_word;

                                assistantBubble.innerHTML = `
                                    <b>Definition:</b> ${parsed.definition}<br>
                                    <b>Examples:</b> ${(parsed.examples || []).join(", ")}
                                `;
                                makeClickable(chatDiv);
                                chatDiv.scrollTop = chatDiv.scrollHeight;
                                return;
                            }
                        }
                    } catch (e) {
                        // JSON not complete yet — keep streaming
                    }

                    assistantBubble.innerHTML = result;
                    chatDiv.scrollTop = chatDiv.scrollHeight;
                }
            } catch(e) {
                console.warn("Non-JSON chunk:", line);
            }
        }
    }

    makeClickable(chatDiv);
    chatDiv.scrollTop = chatDiv.scrollHeight;
}

/* ─── Voice Recognition ───────────────────────────────────────── */

window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const micBtn = document.getElementById("micBtn");

if (window.SpeechRecognition) {
    const recognition       = new SpeechRecognition();
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.lang            = 'en-US';

    let isRecording     = false;
    let finalTranscript = "";

    micBtn.textContent = "🎤";

    micBtn.addEventListener("click", () => {
        if (!isRecording) {
            finalTranscript = "";
            recognition.start();
            isRecording = true;
            micBtn.textContent = "⏹️";
        } else {
            recognition.stop();
        }
    });

    recognition.onresult = (event) => {
        let interimTranscript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) finalTranscript += t + " ";
            else interimTranscript += t;
        }
        input.value = (finalTranscript + interimTranscript).trim();
    };

    recognition.onend = () => {
        isRecording = false;
        micBtn.textContent = "🎤";
    };

    recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        isRecording = false;
        micBtn.textContent = "🎤";
    };

    sendBtn.addEventListener("click", () => { if (isRecording) recognition.stop(); });
} else {
    console.warn("Web Speech API not supported in this browser.");
}

if (selectedTopic) {
    startTopicConversation(selectedTopic);
}