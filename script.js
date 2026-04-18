// Cache DOM Elements for better performance
const UI = {
  video: document.getElementById("videoInput"),
  status: document.getElementById("status"),
  canvasOutput: document.getElementById("canvasOutput"),
  canvasThree: document.getElementById("canvasThree"),
  dialogue: document.getElementById("dialogue-ui"),
  exercise: document.getElementById("exercise-ui"),
  grid: document.getElementById("options-grid"),
  revealArrow: document.getElementById("reveal-options-arrow"),
  txtElem: document.getElementById("dialogue-text"),
  backArrow: document.getElementById("back-arrow"),
  instruction: document.getElementById("exercise-instruction"),
  restartBtn: document.getElementById("restart-btn"),
  tooltip: document.getElementById("word-tooltip"), // --- NEW GLOSSARY FEATURE ---
};

// Global State
let gameData = null,
  currentSceneId = 0,
  currentStateId = 0,
  history = [],
  textureLoader;
let src,
  cap,
  qrDetector,
  camMatrix,
  distCoeffs,
  rvec,
  tvec,
  rotMatr,
  objectPoints;
let renderer, scene, camera, arGroup;

const AR_SCALE = 1.0;
const layerBoundsCache = new Map();

// --- NEW GLOSSARY FEATURE ---
// Define your difficult words and their meanings here
const GLOSSARY = {
  Serene: "Calm, peaceful, and untroubled; free from disturbance or agitation.",
  Cautious:
    "Careful to avoid potential problems or dangers; showing prudent judgment.",
  Maze: "A complex network of paths or passages designed to confuse, in which it is difficult to find one’s way",
  Backroads:
    "Minor or less-traveled roads, typically in rural areas, away from main routes.",
  Vendors:
    "People or businesses that sell goods or services, especially in markets or public places",
};

// Function to find glossary words in the text and wrap them in clickable spans
function formatPromptText(text) {
  let formattedText = text;
  for (const [word, definition] of Object.entries(GLOSSARY)) {
    // This regex looks for whole words, case-insensitive
    const regex = new RegExp(`\\b(${word})\\b`, "gi");
    // Replace the word with a span containing the definition as a data attribute
    formattedText = formattedText.replace(
      regex,
      `<span class="difficult-word" data-def="${definition}">$1</span>`
    );
  }
  return formattedText;
}

// Event Listeners
UI.backArrow.addEventListener("click", handleBack);
UI.restartBtn.addEventListener("click", restartGame);
window.addEventListener("resize", fitToScreen);

// --- NEW GLOSSARY FEATURE ---
// Handle clicking on difficult words and anywhere else to close the tooltip
document.addEventListener("click", (e) => {
  // If we clicked a difficult word
  if (e.target.classList.contains("difficult-word")) {
    const wordEl = e.target;
    const definition = wordEl.getAttribute("data-def");

    // Populate the tooltip text
    UI.tooltip.innerText = definition;

    // Calculate position (centered above the word)
    const rect = wordEl.getBoundingClientRect();
    UI.tooltip.style.left = `${rect.left + rect.width / 2}px`;
    // Position slightly above the word
    UI.tooltip.style.top = `${rect.top - UI.tooltip.offsetHeight - 15}px`;

    // Show tooltip
    UI.tooltip.classList.add("visible");
  }
  // If we clicked anywhere else, hide the tooltip
  else {
    if (UI.tooltip) UI.tooltip.classList.remove("visible");
  }
});

async function loadGameData() {
  try {
    const response = await fetch("data.json");
    gameData = await response.json();
    startCamera();
  } catch (e) {
    UI.status.innerText = "Error loading data.json";
  }
}

function startCamera() {
  UI.status.innerText = "Starting Camera...";
  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    .then((stream) => {
      UI.video.srcObject = stream;
      UI.video.onloadedmetadata = () => {
        UI.video.play();
        const w = UI.video.videoWidth;
        const h = UI.video.videoHeight;
        UI.video.width = w;
        UI.video.height = h;
        UI.canvasOutput.width = w;
        UI.canvasOutput.height = h;
        UI.canvasThree.width = w;
        UI.canvasThree.height = h;
        fitToScreen();
        checkOpenCV();
      };
    })
    .catch((err) => {
      UI.status.innerText = "Camera access denied.";
    });
}

function checkOpenCV() {
  if (typeof cv !== "undefined" && cv.Mat) {
    initThree();
    initCV();
    requestAnimationFrame(processFrame);
  } else {
    setTimeout(checkOpenCV, 100);
  }
}

function getOpaqueBounds(image, cacheKey) {
  if (layerBoundsCache.has(cacheKey)) {
    return layerBoundsCache.get(cacheKey);
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);

  const { data } = ctx.getImageData(0, 0, width, height);
  const opaque = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (data[index * 4 + 3] > 10) {
        opaque[index] = 1;
      }
    }
  }

  const visited = new Uint8Array(width * height);
  const minComponentArea = Math.max(48, Math.round(width * height * 0.0002));
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let hasLargeComponent = false;

  for (let start = 0; start < opaque.length; start += 1) {
    if (!opaque[start] || visited[start]) {
      continue;
    }

    const stack = [start];
    visited[start] = 1;
    let componentArea = 0;
    let componentMinX = width;
    let componentMinY = height;
    let componentMaxX = -1;
    let componentMaxY = -1;

    while (stack.length > 0) {
      const current = stack.pop();
      const x = current % width;
      const y = Math.floor(current / width);

      componentArea += 1;
      if (x < componentMinX) componentMinX = x;
      if (y < componentMinY) componentMinY = y;
      if (x > componentMaxX) componentMaxX = x;
      if (y > componentMaxY) componentMaxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }

          const next = ny * width + nx;
          if (!opaque[next] || visited[next]) {
            continue;
          }

          visited[next] = 1;
          stack.push(next);
        }
      }
    }

    if (componentArea >= minComponentArea) {
      hasLargeComponent = true;
      if (componentMinX < minX) minX = componentMinX;
      if (componentMinY < minY) minY = componentMinY;
      if (componentMaxX > maxX) maxX = componentMaxX;
      if (componentMaxY > maxY) maxY = componentMaxY;
    }
  }

  if (!hasLargeComponent) {
    minX = width;
    minY = height;
    maxX = -1;
    maxY = -1;

    for (let index = 0; index < opaque.length; index += 1) {
      if (!opaque[index]) {
        continue;
      }

      const x = index % width;
      const y = Math.floor(index / width);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const bounds =
    maxX >= 0
      ? {
          minX,
          minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          fullWidth: width,
          fullHeight: height,
        }
      : {
          minX: 0,
          minY: 0,
          width,
          height,
          fullWidth: width,
          fullHeight: height,
        };

  layerBoundsCache.set(cacheKey, bounds);
  return bounds;
}

function createTrimmedTexture(image, bounds) {
  const isFullImage =
    bounds.minX === 0 &&
    bounds.minY === 0 &&
    bounds.width === bounds.fullWidth &&
    bounds.height === bounds.fullHeight;

  if (isFullImage) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    image,
    bounds.minX,
    bounds.minY,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height
  );

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createLayerGeometry(bounds) {
  const width = bounds.width / Math.max(bounds.fullWidth, 1);
  const height = bounds.height / Math.max(bounds.fullHeight, 1);
  return new THREE.PlaneGeometry(width, height);
}

function getLayerOffset(bounds) {
  const centerX = bounds.minX + bounds.width / 2;
  const centerY = bounds.minY + bounds.height / 2;

  return {
    x: centerX / bounds.fullWidth - 0.5,
    y: 0.5 - centerY / bounds.fullHeight,
  };
}

function loadScene(sceneId, isBack = false) {
  if (!gameData) return;
  currentSceneId = sceneId;
  const sceneData = gameData.scenes.find((s) => s.id == sceneId);
  if (!sceneData) return;

  // Clean up
  while (arGroup.children.length > 0) {
    const obj = arGroup.children[0];
    if (obj.material.map) obj.material.map.dispose();
    obj.material.dispose();
    obj.geometry.dispose();
    arGroup.remove(obj);
  }

  sceneData.layers.forEach((layer, index) => {
    const basePosition = [...layer.position];
    const planeGeo = new THREE.PlaneGeometry(1, 1);
    const texture = textureLoader.load(layer.image, () => {
      if (!mesh.parent) {
        texture.dispose();
        return;
      }

      const bounds = getOpaqueBounds(texture.image, layer.image);
      const trimmedTexture = createTrimmedTexture(texture.image, bounds);
      const offset = getLayerOffset(bounds);

      mesh.geometry.dispose();
      mesh.geometry = createLayerGeometry(bounds);
      mesh.position.set(
        basePosition[0] + offset.x,
        basePosition[1] + offset.y,
        basePosition[2]
      );

      if (trimmedTexture) {
        material.map = trimmedTexture;
        texture.dispose();
      }

      material.needsUpdate = true;
    });
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(planeGeo, material);
    mesh.position.set(...layer.position);
    mesh.rotation.set(...layer.rotation);
    mesh.renderOrder = index;
    arGroup.add(mesh);
  });

  if (!isBack) loadState(0);
}
function loadState(stateId, isBack = false) {
  const sceneData = gameData.scenes.find((s) => s.id == currentSceneId);
  const stateData = sceneData.states.find((s) => s.id == stateId);

  if (stateData.next_scene !== undefined) {
    if (!isBack) history.push({ scene: currentSceneId, state: currentStateId });
    loadScene(parseInt(stateData.next_scene), isBack);
    return;
  }

  if (!isBack && (currentSceneId !== 0 || stateId !== 0)) {
    history.push({ scene: currentSceneId, state: currentStateId });
  }
  currentStateId = stateId;

  // 1. ALWAYS show the dialogue UI first
  UI.exercise.style.display = "none";
  UI.dialogue.style.display = "block";
  UI.backArrow.style.display = history.length > 0 ? "inline-block" : "none";

  // --- NEW GLOSSARY FEATURE: format the text before setting it ---
  UI.txtElem.innerHTML = formatPromptText(stateData.prompt);
  UI.txtElem.classList.remove("two-lines");
  UI.grid.innerHTML = "";

  // 2. Check if we have choices
  if (
    stateData.choices &&
    stateData.choices.length > 0 &&
    !stateData.exercise
  ) {
    stateData.choices.forEach((choice) => {
      const btn = document.createElement("button");
      btn.className = "dialogue-btn";
      btn.innerText = choice.text;
      btn.onclick = () => loadState(choice.next_state);
      UI.grid.appendChild(btn);
    });
  } else {
    // 3. START EXERCISE button
    const btn = document.createElement("button");
    btn.className = "dialogue-btn";
    btn.style.gridColumn = "1 / -1";
    btn.innerText = "START EXERCISE ►";
    btn.onclick = () => {
      UI.dialogue.style.display = "none";
      UI.exercise.style.display = "block";
      // Use backticks (`) for multi-line strings
      UI.instruction.innerText =
        stateData.exercise ||
        `Based on the story path you followed on the website, write a paragraph of 120–150 words describing your story.
Explain the choices you made
Add details to make your story clear and interesting
You may include your own ideas`;
    };
    UI.grid.appendChild(btn);
  }

  // 4. "READ MORE" dropdown logic
  if (stateData.prompt.length > 90) {
    UI.txtElem.classList.add("two-lines");
    UI.grid.style.display = "none";
    UI.revealArrow.style.display = "block";

    UI.revealArrow.onclick = () => {
      UI.txtElem.classList.remove("two-lines");
      UI.revealArrow.style.display = "none";
      UI.grid.style.display = "grid";
    };
  } else {
    UI.grid.style.display = "grid";
    UI.revealArrow.style.display = "none";
  }
}

function restartGame() {
  history = [];
  UI.exercise.style.display = "none";
  loadScene(0);
}

function handleBack() {
  if (history.length > 0) {
    const prev = history.pop();
    if (prev.scene !== currentSceneId) loadScene(prev.scene, true);
    loadState(prev.state, true);
  }
}

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas: UI.canvasThree,
    alpha: true,
    antialias: true,
  });
  renderer.setSize(UI.video.width, UI.video.height, false);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    45,
    UI.video.width / UI.video.height,
    0.1,
    1000
  );
  arGroup = new THREE.Group();
  arGroup.visible = false;
  arGroup.matrixAutoUpdate = false;
  scene.add(arGroup);
  textureLoader = new THREE.TextureLoader();
  loadScene(0);
}

function initCV() {
  src = new cv.Mat(UI.video.height, UI.video.width, cv.CV_8UC4);
  cap = new cv.VideoCapture(UI.video);
  qrDetector = new cv.QRCodeDetector();
  const f = Math.max(UI.video.width, UI.video.height);
  camMatrix = cv.matFromArray(3, 3, cv.CV_64FC1, [
    f,
    0,
    UI.video.width / 2,
    0,
    f,
    UI.video.height / 2,
    0,
    0,
    1,
  ]);
  distCoeffs = new cv.Mat.zeros(5, 1, cv.CV_64FC1);
  objectPoints = cv.matFromArray(
    4,
    3,
    cv.CV_64FC1,
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
  );
  rvec = new cv.Mat();
  tvec = new cv.Mat();
  rotMatr = new cv.Mat(3, 3, cv.CV_64FC1);
  camera.projectionMatrix.set(
    (2 * f) / UI.video.width,
    0,
    0,
    0,
    0,
    (2 * f) / UI.video.height,
    0,
    0,
    0,
    0,
    -1.002,
    -0.2,
    0,
    0,
    -1,
    0
  );
}

function processFrame() {
  cap.read(src);
  cv.imshow("canvasOutput", src);
  let points = new cv.Mat();

  if (qrDetector.detect(src, points)) {
    let imgPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      points.data32F[0],
      points.data32F[1],
      points.data32F[2],
      points.data32F[3],
      points.data32F[4],
      points.data32F[5],
      points.data32F[6],
      points.data32F[7],
    ]);

    if (cv.solvePnP(objectPoints, imgPts, camMatrix, distCoeffs, rvec, tvec)) {
      cv.Rodrigues(rvec, rotMatr);
      let r = rotMatr.data64F,
        t = tvec.data64F;
      const m = new THREE.Matrix4();

      m.set(
        r[0] * AR_SCALE,
        r[1] * AR_SCALE,
        r[2] * AR_SCALE,
        t[0],
        -r[3] * AR_SCALE,
        -r[4] * AR_SCALE,
        -r[5] * AR_SCALE,
        -t[1],
        -r[6] * AR_SCALE,
        -r[7] * AR_SCALE,
        -r[8] * AR_SCALE,
        -t[2],
        0,
        0,
        0,
        1
      );

      arGroup.matrix.copy(m);
      arGroup.visible = true;
      UI.status.innerText = "QR DETECTED";
    }
    imgPts.delete(); // Important: prevents memory leaks per frame
  } else {
    arGroup.visible = false;
    UI.status.innerText = "SCANNING...";
  }

  renderer.render(scene, camera);
  points.delete(); // Important: prevents memory leaks per frame
  requestAnimationFrame(processFrame);
}

function fitToScreen() {
  const scale = Math.max(
    window.innerWidth / UI.video.videoWidth,
    window.innerHeight / UI.video.videoHeight
  );
  [UI.canvasOutput, UI.canvasThree].forEach((c) => {
    c.style.width = UI.video.videoWidth * scale + "px";
    c.style.height = UI.video.videoHeight * scale + "px";
  });
}

// Initialize
loadGameData();
