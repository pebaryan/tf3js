import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createLevel } from './level';
import { Player } from './player';

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let player: Player;
let clock: THREE.Clock;
let world: CANNON.World;
let isPlaying = false;

function init() {
  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 50, 200);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 2, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('game-container')!.appendChild(renderer.domElement);

  const ambientLight = new THREE.AmbientLight(0x404060, 0.5);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(50, 100, 50);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  dirLight.shadow.camera.near = 10;
  dirLight.shadow.camera.far = 200;
  dirLight.shadow.camera.left = -50;
  dirLight.shadow.camera.right = 50;
  dirLight.shadow.camera.top = 50;
  dirLight.shadow.camera.bottom = -50;
  scene.add(dirLight);

  // Physics world – gravity = 0 because player handles its own gravity.
  // Static bodies (floor/walls) don't need gravity anyway.
  world = new CANNON.World();
  world.gravity.set(0, 0, 0);

  createLevel(scene, world);

  player = new Player(camera, scene, world);
  scene.add(player.group);

  window.addEventListener('resize', onWindowResize);

  const instructions = document.getElementById('instructions')!;
  instructions.addEventListener('click', () => {
    instructions.classList.add('hidden');
    player.lockPointer();
    isPlaying = true;
  });

  animate();
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  if (isPlaying && player) {
    // 1. Player computes desired velocity and writes it to body
    player.update(delta);
    // 2. Cannon resolves collisions (pushes body out of walls/floor)
    world.step(1 / 60, delta, 3);
    // 3. Sync group position from cannon result
    player.group.position.set(
      player.body.position.x,
      player.body.position.y,
      player.body.position.z,
    );
  }

  renderer.render(scene, camera);
}

init();
