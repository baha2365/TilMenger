import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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


async function startTopicConversation(topic) {

    const starterMessage = `Let's practice English conversation about ${topic}. Ask me simple questions about this topic.`;

    chatDiv.innerHTML += `<p><b>Topic:</b> ${topic}</p>`;

    const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: starterMessage })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";

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
                    chatDiv.innerHTML = `<p><b>Assistant:</b> ${result}</p>`;
                }
            } catch(e) {}
        }
    }
}

let mixer;
let animations = [];
let activeAction;
let idleAction;

// 2. Renderer Setup
const renderer = new THREE.WebGLRenderer({ antialias: true , alpha:true});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // Better colors for GLB
document.body.appendChild(renderer.domElement);

// 3. Lighting (Vital for GLB models)
const ambientLight = new THREE.AmbientLight(0xffffff, 1);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
directionalLight.position.set(5, 5, 5);
scene.add(directionalLight);

// 5. Loading the GLB File
const loader = new GLTFLoader();
loader.load(
    '../game_girl.glb', // <--- REPLACE THIS WITH YOUR FILE PATH
    (gltf) => {
        const model = gltf.scene;
        scene.add(model);

        mixer = new THREE.AnimationMixer(model);
        animations = gltf.animations;

        idleAction = mixer.clipAction(animations[2]);
        idleAction.play();
        activeAction = idleAction;

        // 🔥 finished listener тек 1 рет
        mixer.addEventListener('finished', () => {
            fadeToIdle();
        });

        console.log("Model loaded successfully!");
    },
    (xhr) => {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
    },
    (error) => {
        console.error('Error loading model:', error);
    }
);



// 7. Handle Window Resize
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

/* ============================= */
/*  RENDER LOOP                  */
/* ============================= */

const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    if (mixer) mixer.update(clock.getDelta());
    renderer.render(scene, camera);
}

animate();


const sendBtn = document.getElementById("sendBtn");
const input = document.getElementById("userInput");
const chatDiv = document.getElementById("chat");

sendBtn.addEventListener("click", sendMessage);
input.addEventListener("keypress", function(e) {
    if (e.key === "Enter") sendMessage();
});

async function sendMessage() {
    const message = input.value;
    if (!message) return;

    chatDiv.innerHTML += `<p><b>You:</b> ${message}</p>`;
    input.value = "";

    const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
    });

    

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Chunk-ті textке айналдырамыз
        const chunkText = decoder.decode(value, { stream: true });

        // Әр chunk JSON болса, parse жасап content аламыз
        const lines = chunkText.split("\n").filter(l => l.trim() !== "");
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.message?.content) {
                    result += obj.message.content;
                    playAnimation(0);

                    try {
                        try {

                            // Find JSON object inside text
                            const jsonStart = result.indexOf("{");
                            const jsonEnd = result.lastIndexOf("}");

                            if (jsonStart !== -1 && jsonEnd !== -1) {

                                const jsonString = result.substring(jsonStart, jsonEnd + 1);
                                const parsed = JSON.parse(jsonString);

                                if (parsed.main_word) {

                                    document.getElementById("mainWordBox").style.display = "block";
                                    document.getElementById("mainWordBox").innerText = parsed.main_word;

                                    chatDiv.innerHTML = `
                                        <p><b>Definition:</b> ${parsed.definition}</p>
                                        <p><b>Examples:</b></p>
                                        <ul>
                                            ${parsed.examples.map(e => `<li>${e}</li>`).join("")}
                                        </ul>
                                    `;

                                    return;
                                }
                            }

                        } catch (e) {
                            // JSON not ready yet
                        }

                        if (parsed.main_word) {
                            document.getElementById("mainWordBox").style.display = "block";
                            document.getElementById("mainWordBox").innerText = parsed.main_word;

                            chatDiv.innerHTML = `
                                <p><b>Definition:</b> ${parsed.definition}</p>
                                <p><b>Examples:</b></p>
                                <ul>
                                    ${parsed.examples.map(e => `<li>${e}</li>`).join("")}
                                </ul>
                            `;
                            return;
                        }
                    } catch (e) {
                        // not full JSON yet, keep collecting
                    }

                    chatDiv.innerHTML = `<p><b>Assistant:</b> ${result}</p>`;
                }
            } catch(e) {
                console.warn("Non-JSON chunk:", line);
            }
        }
    }
}



/* ============================= */
/*  VOICE RECOGNITION            */
/* ============================= */

window.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const micBtn = document.getElementById("micBtn");

if (window.SpeechRecognition) {

    const recognition = new SpeechRecognition();
    recognition.continuous = true;       // ✅ keep listening
    recognition.interimResults = true;   // ✅ live updating
    recognition.lang = 'en-US';

    let isRecording = false;
    let finalTranscript = "";

    micBtn.textContent = "🎤";

    micBtn.addEventListener("click", () => {

        if (!isRecording) {
            finalTranscript = "";
            recognition.start();
            isRecording = true;
            micBtn.textContent = "⏹️";
            console.log("Voice recognition started...");
        } else {
            recognition.stop();
        }

    });

    recognition.onresult = function(event) {

        let interimTranscript = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;

            if (event.results[i].isFinal) {
                finalTranscript += transcript + " ";
            } else {
                interimTranscript += transcript;
            }
        }

        // Live update input field
        input.value = (finalTranscript + interimTranscript).trim();
    };

    recognition.onend = function() {
        isRecording = false;
        micBtn.textContent = "🎤";
        console.log("Voice recognition stopped.");
    };

    recognition.onerror = function(event) {
        console.error("Speech recognition error:", event.error);
        isRecording = false;
        micBtn.textContent = "🎤";
    };

    // ✅ IMPORTANT: Stop recording when Send is clicked
    sendBtn.addEventListener("click", () => {
        if (isRecording) {
            recognition.stop();
        }
    });

} else {
    console.warn("Web Speech API not supported in this browser.");
}



if (selectedTopic) {
    startTopicConversation(selectedTopic);
}