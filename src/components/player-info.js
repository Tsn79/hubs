import { injectCustomShaderChunks } from "../utils/media-utils";
import { AVATAR_TYPES } from "../utils/avatar-utils";
import { registerComponentInstance, deregisterComponentInstance } from "../utils/component-utils";
import defaultAvatar from "../assets/models/DefaultAvatar.glb";
import { MediaDevicesEvents } from "../utils/media-devices-utils";
import anime from "animejs";
import MovingAverage from "moving-average";
import { getThemeColor } from "../utils/theme";
import qsTruthy from "../utils/qs_truthy";
import { findAncestorWithComponent } from "../utils/scene-graph";

const DEBUG = qsTruthy("debug");
const NAMETAG_BACKGROUND_PADDING = 0.05;
const NAMETAG_STATUS_BORDER_PADDING = 0.035;
const NAMETAG_MIN_WIDTH = 0.6;
const NAMETAG_HEIGHT = 0.25;
const NAMETAG_OFFSET = 0.15;
const NAMETAG_HAND_OFFSET = 0.3;
const TYPING_ANIM_SPEED = 150;

function ensureAvatarNodes(json) {
  const { nodes } = json;
  if (!nodes.some(node => node.name === "Head")) {
    // If the avatar model doesn't have a Head node. The user has probably chosen a custom GLB.
    // So, we need to construct a suitable hierarchy for avatar functionality to work.
    // We re-parent the original root node to the Head node and set the scene root to a new AvatarRoot.

    // Note: We assume that the first node in the primary scene is the one we care about.
    const originalRoot = json.scenes[json.scene].nodes[0];
    nodes.push({ name: "LeftEye", extensions: { MOZ_hubs_components: {} } });
    nodes.push({ name: "RightEye", extensions: { MOZ_hubs_components: {} } });
    nodes.push({
      name: "Head",
      children: [originalRoot, nodes.length - 1, nodes.length - 2],
      extensions: { MOZ_hubs_components: { "scale-audio-feedback": "" } }
    });
    nodes.push({ name: "Neck", children: [nodes.length - 1] });
    nodes.push({ name: "Spine", children: [nodes.length - 1] });
    nodes.push({ name: "Hips", children: [nodes.length - 1] });
    nodes.push({ name: "AvatarRoot", children: [nodes.length - 1] });
    json.scenes[json.scene].nodes[0] = nodes.length - 1;
  }
  return json;
}

const ANIM_CONFIG = {
  duration: 400,
  easing: "easeOutElastic",
  elasticity: 400,
  loop: 0,
  round: false
};

function animComp(el, component, props, { onComplete, showOnStart, hideOnEnd } = {}) {
  const cmp = el?.components[component];
  if (!el || !cmp) return;
  const config = Object.assign({}, ANIM_CONFIG, props, {
    targets: el.components[component].data,
    begin: () => {
      if (showOnStart !== undefined) el.setAttribute("visible", showOnStart);
    },
    update: anim => {
      el.setAttribute(component, anim.animatables[0].target);
    },
    complete: anim => {
      el.setAttribute(component, anim.animatables[0].target);
      if (hideOnEnd !== undefined) el.setAttribute("visible", !hideOnEnd);
      onComplete && onComplete();
    }
  });
  anime(config);
}

/**
 * Sets player info state, including avatar choice and display name.
 * @namespace avatar
 * @component player-info
 */
AFRAME.registerComponent("player-info", {
  schema: {
    avatarSrc: { type: "string" },
    avatarType: { type: "string", default: AVATAR_TYPES.SKINNABLE },
    muted: { default: false },
    isSharingAvatarCamera: { default: false }
  },
  init() {
    this.displayName = null;
    this.identityName = null;
    this.isFirstNametagPass = true;
    this.isTalking = false;
    this.isTyping = false;
    this.isOwner = false;
    this.isRecording = false;
    this.isHandRaised = false;
    this.volumeAvg = new MovingAverage(128);
    this.wsNametagVisible = false;
    this.isNametagVisible = false;
    this.size = new THREE.Vector3();
    this.avatarBBAA = new THREE.Box3();
    this.avatarBBAASize = new THREE.Vector3();
    this.avatarBBAACenter = new THREE.Vector3();
    this.applyProperties = this.applyProperties.bind(this);
    this.updateDisplayName = this.updateDisplayName.bind(this);
    this.applyDisplayName = this.applyDisplayName.bind(this);
    this.handleModelLoaded = this.handleModelLoaded.bind(this);
    this.handleModelError = this.handleModelError.bind(this);
    this.handleRemoteModelError = this.handleRemoteModelError.bind(this);
    this.update = this.update.bind(this);
    this.onMicStateChanged = this.onMicStateChanged.bind(this);
    this.onAnalyserVolumeUpdated = this.onAnalyserVolumeUpdated.bind(this);

    this.isLocalPlayerInfo = this.el.id === "avatar-rig";
    this.avatarRig = document.getElementById("avatar-rig");
    this.playerSessionId = null;
    this.ikRootEl = findAncestorWithComponent(this.el, "ik-root");

    if (!this.isLocalPlayerInfo) {
      NAF.utils.getNetworkedEntity(this.el).then(networkedEntity => {
        this.playerSessionId = NAF.utils.getCreator(networkedEntity);
        const playerPresence = window.APP.hubChannel.presence.state[this.playerSessionId];
        if (playerPresence) {
          this.updateFromPresenceMeta(playerPresence.metas[0]);
        }
      });
      if (DEBUG) {
        this.avatarBBAAHelper = new THREE.Box3Helper(this.avatarBBAA, 0xffff00);
        this.el.sceneEl.object3D.add(this.avatarBBAAHelper);
      }
    }
    registerComponentInstance(this, "player-info");
    this.nametagVisibility = window.APP.store.state.preferences.nametagVisibility;
    this.nametagVisibilityDistance = window.APP.store.state.preferences.nametagVisibilityDistance;
  },
  remove() {
    clearTimeout(this.frozenTimer);
    const avatarEl = this.el.querySelector("[avatar-audio-source]");
    APP.isAudioPaused.delete(avatarEl);
    deregisterComponentInstance(this, "player-info");
    if (DEBUG) this.el.sceneEl.object3D.remove(this.avatarBBAAHelper);
  },
  tick: (() => {
    let typingAnimTime = 0;
    const worldPos = new THREE.Vector3();
    const avatarRigWorldPos = new THREE.Vector3();
    return function(t) {
      if (this.isLocalPlayerInfo) return;
      if (this.nametagVisibility === "showClose") {
        this.avatarRig.object3D.getWorldPosition(avatarRigWorldPos);
        this.el.object3D.getWorldPosition(worldPos);
        this.wasNametagVisible = this.isNametagVisible;
        this.isNametagVisible = avatarRigWorldPos.sub(worldPos).length() < this.nametagVisibilityDistance;
        this.updateNameTag();
      }
      if (this.nametagTypingEl && !this.isTalking && this.isTyping) {
        typingAnimTime = t;
        this.nametagTypingEl.object3D.traverse(o => {
          if (o.material) {
            o.material.opacity = (Math.sin(typingAnimTime / TYPING_ANIM_SPEED) + 1) / 2;
            typingAnimTime -= TYPING_ANIM_SPEED;
          }
        });
      }
      if (DEBUG) {
        this.updateAvatarModelBBAA();
        this.avatarBBAAHelper.matrixNeedsUpdate = true;
        this.avatarBBAAHelper.updateMatrixWorld(true);
      }
    };
  })(),
  play() {
    this.el.addEventListener("model-loaded", this.handleModelLoaded);
    this.el.sceneEl.addEventListener("presence_updated", this.updateDisplayName);
    if (this.isLocalPlayerInfo) {
      this.el.querySelector(".model").addEventListener("model-error", this.handleModelError);
    } else {
      this.el.querySelector(".model").addEventListener("model-error", this.handleRemoteModelError);
    }
    window.APP.store.addEventListener("statechanged", this.update);

    this.el.sceneEl.addEventListener("stateadded", this.update);
    this.el.sceneEl.addEventListener("stateremoved", this.update);
    this.el.sceneEl.addEventListener("presence_updated", this.update);

    if (this.isLocalPlayerInfo) {
      APP.dialog.on("mic-state-changed", this.onMicStateChanged);
    } else {
      this.el.addEventListener("analyser-volume-updated", this.onAnalyserVolumeUpdated);
    }
  },
  pause() {
    this.el.removeEventListener("model-loaded", this.handleModelLoaded);
    this.el.sceneEl.removeEventListener("presence_updated", this.updateDisplayName);
    if (this.isLocalPlayerInfo) {
      this.el.querySelector(".model").removeEventListener("model-error", this.handleModelError);
    } else {
      this.el.querySelector(".model").removeEventListener("model-error", this.handleRemoteModelError);
    }
    this.el.sceneEl.removeEventListener("stateadded", this.update);
    this.el.sceneEl.removeEventListener("stateremoved", this.update);
    this.el.sceneEl.removeEventListener("presence_updated", this.update);
    window.APP.store.removeEventListener("statechanged", this.update);

    if (this.isLocalPlayerInfo) {
      APP.dialog.off("mic-state-changed", this.onMicStateChanged);
    } else {
      this.el.removeEventListener("analyser-volume-updated", this.onAnalyserVolumeUpdated);
    }
  },

  update(oldData) {
    if (this.data.muted !== oldData.muted) {
      this.el.emit("remote_mute_updated", { muted: this.data.muted });
    }
    this.applyProperties();
  },
  updateDisplayName(e) {
    if (!this.playerSessionId && this.isLocalPlayerInfo) {
      this.playerSessionId = NAF.clientId;
    }
    if (!this.playerSessionId) return;
    if (this.playerSessionId !== e.detail.sessionId) return;

    this.updateFromPresenceMeta(e.detail);
  },
  updateFromPresenceMeta(presenceMeta) {
    this.permissions = presenceMeta.permissions;
    this.displayName = presenceMeta.profile.displayName;
    this.identityName = presenceMeta.profile.identityName;
    this.applyDisplayName();
    this.isRecording = !!(presenceMeta.streaming || presenceMeta.recording);
    this.isOwner = !!(presenceMeta.roles && presenceMeta.roles.owner);
    this.isTyping = !!presenceMeta.typing;
    this.isHandRaised = !!presenceMeta.handRaised;
    this.updateNameTag();
  },
  can(perm) {
    return !!this.permissions && this.permissions[perm];
  },
  applyDisplayName() {
    this.isNametagVisible = !this.isLocalPlayerInfo;
    this.nametagVisibilityDistance = window.APP.store.state.preferences.nametagVisibilityDistance;
    this.nametagVisibility = window.APP.store.state.preferences.nametagVisibility;
    this.wasNametagVisible = this.isNametagVisible;
    if (this.nametagVisibility === "showNone") {
      this.isNametagVisible = false;
    } else if (this.nametagVisibility === "showAll") {
      this.isNametagVisible = true;
    } else if (this.nametagVisibility === "showFrozen") {
      this.isNametagVisible = this.el.sceneEl.is("frozen");
    } else if (this.nametagVisibility === "showSpeaking") {
      this.isNametagVisible = this.isTalking;
    }
    this.updateNameTag();

    this.nametagEl = this.el.querySelector(".nametag");
    if (this.displayName && this.nametagEl) {
      this.nametagTextEl = this.el.querySelector(".nametag-text");
      this.nametagTextEl.addEventListener(
        "text-updated",
        () => {
          this.size = this.nametagTextEl.components["text"].getSize();
          this.size.x = Math.max(this.size.x, NAMETAG_MIN_WIDTH);
          this.updateNameTag();
        },
        { once: true }
      );
      if (this.displayName.length > 18) {
        this.displayName = this.displayName.slice(0, 18).concat("...");
      }
      this.nametagTextEl.setAttribute("text", {
        value: this.displayName
      });
    }

    const identityNameEl = this.el.querySelector(".identityName");
    if (identityNameEl) {
      if (this.identityName) {
        if (this.identityName.length > 18) {
          this.identityName = this.identityName.slice(0, 18).concat("...");
        }
        identityNameEl.setAttribute("text", { value: this.identityName });
        identityNameEl.object3D.visible = this.el.sceneEl.is("frozen");
      }
    }
  },
  applyProperties(e) {
    this.applyDisplayName();

    const modelEl = this.el.querySelector(".model");
    if (this.data.avatarSrc && modelEl) {
      modelEl.components["gltf-model-plus"].jsonPreprocessor = ensureAvatarNodes;
      modelEl.setAttribute("gltf-model-plus", "src", this.data.avatarSrc);
    }

    if (!e || e.target === modelEl) {
      const uniforms = injectCustomShaderChunks(this.el.object3D);
      this.el.querySelectorAll("[hover-visuals]").forEach(el => {
        el.components["hover-visuals"].uniforms = uniforms;
      });
    }

    const videoTextureTargets = modelEl.querySelectorAll("[video-texture-target]");

    const sessionId = this.isLocalPlayerInfo ? NAF.clientId : this.playerSessionId;

    for (const el of Array.from(videoTextureTargets)) {
      el.setAttribute("video-texture-target", {
        src: this.data.isSharingAvatarCamera ? `hubs://clients/${sessionId}/video` : ""
      });

      if (this.isLocalPlayerInfo) {
        el.setAttribute("emit-scene-event-on-remove", `event:${MediaDevicesEvents.VIDEO_SHARE_ENDED}`);
      }
    }

    const avatarEl = this.el.querySelector("[avatar-audio-source]");
    if (this.data.muted) {
      APP.isAudioPaused.add(avatarEl);
    } else {
      APP.isAudioPaused.delete(avatarEl);
    }

    this.updateNameTag();
  },
  handleModelLoaded() {
    this.nametagBackgroundEl = this.el.querySelector(".nametag-background");
    this.nametagVolumeEl = this.el.querySelector(".nametag-volume");
    this.nametagStatusBorderEl = this.el.querySelector(".nametag-status-border");
    this.recordingBadgeEl = this.el.querySelector(".recordingBadge");
    this.modBadgeEl = this.el.querySelector(".modBadge");
    this.handRaisedEl = this.el.querySelector(".hand-raised-id");
    this.nametagTypingEl = this.el.querySelector(".nametag-typing");
    if (this.nametagTextEl) {
      this.size = this.nametagTextEl.components["text"].getSize();
      this.size.x = Math.max(this.size.x, NAMETAG_MIN_WIDTH);
    }
    setTimeout(() => {
      this.applyProperties();
    }, 500);
  },
  handleModelError() {
    window.APP.store.resetToRandomDefaultAvatar();
  },
  handleRemoteModelError() {
    this.data.avatarSrc = defaultAvatar;
    this.applyProperties();
  },
  onMicStateChanged({ enabled }) {
    this.el.setAttribute("player-info", { muted: !enabled });
  },

  onAnalyserVolumeUpdated({ detail: { volume } }) {
    let isTalking = false;
    this.volume = volume;
    this.volumeAvg.push(Date.now(), volume);
    if (!this.data.muted) {
      const average = this.volumeAvg.movingAverage();
      isTalking = average > 0.01;
    }
    this.wasTalking = this.isTalking;
    this.isTalking = isTalking;
    if (this.nametagVisibility === "showSpeaking") {
      if (!this.isTalking && this.wasTalking) {
        this.frozenTimer = setTimeout(() => {
          this.wasNametagVisible = this.isNametagVisible;
          this.isNametagVisible = false;
          this.isNametagVisible !== this.wasNametagVisible && this.updateNameTag();
        }, 1000);
      } else if (this.isTalking && !this.wasTalking) {
        clearTimeout(this.frozenTimer);
        this.wasNametagVisible = this.isNametagVisible;
        this.isNametagVisible = true;
        this.isNametagVisible !== this.wasNametagVisible && this.updateNameTag();
      }
    }
    this.isNametagVisible && this.isTalking !== this.wasTalking && this.updateBorder();
    this.isNametagVisible && this.updateVolume();
  },

  updateNameTag() {
    if (this.isLocalPlayerInfo) return;
    this.updateContainer();
    this.updateVolume();
    this.updateState();
  },

  updateContainer() {
    if (this.isLocalPlayerInfo) return;
    this.nametagBackgroundEl = this.nametagBackgroundEl || this.el.querySelector(".nametag-background");
    this.nametagBackgroundEl?.setAttribute("visible", this.isNametagVisible);
    this.nametagBackgroundEl?.setAttribute("slice9", {
      width: this.size.x + NAMETAG_BACKGROUND_PADDING * 2,
      height: NAMETAG_HEIGHT
    });
    this.updateBorder();
  },

  updateVolume() {
    if (this.isLocalPlayerInfo) return;
    this.nametagVolumeEl = this.nametagVolumeEl || this.el.querySelector(".nametag-volume");
    this.nametagVolumeEl?.setAttribute("visible", this.isTalking && this.isNametagVisible);
    this.nametagVolumeEl?.setAttribute("scale", { x: this.volume * this.size.x });
    this.updateTyping();
  },

  updateBorder() {
    if (this.isLocalPlayerInfo) return;
    this.nametagStatusBorderEl = this.nametagStatusBorderEl || this.el.querySelector(".nametag-status-border");
    this.nametagStatusBorderEl?.setAttribute("slice9", {
      width: this.size.x + NAMETAG_BACKGROUND_PADDING * 2 + NAMETAG_STATUS_BORDER_PADDING,
      height: NAMETAG_HEIGHT + NAMETAG_STATUS_BORDER_PADDING
    });
    this.nametagStatusBorderEl?.setAttribute(
      "visible",
      (this.isTyping || this.isTalking || this.isHandRaised) && this.isNametagVisible
    );
    this.nametagStatusBorderEl?.setAttribute(
      "text-button",
      `backgroundColor: ${getThemeColor(
        this.isHandRaised ? "nametag-border-color-raised-hand" : "nametag-border-color"
      )}`
    );
  },

  updateState: (() => {
    const tmpVector = new THREE.Vector3();
    return function() {
      if (this.isLocalPlayerInfo) return;
      this.recordingBadgeEl = this.recordingBadgeEl || this.el.querySelector(".recordingBadge");
      this.recordingBadgeEl?.setAttribute("visible", this.isRecording && this.isNametagVisible);
      this.modBadgeEl = this.modBadgeEl || this.el.querySelector(".modBadge");
      this.modBadgeEl?.setAttribute("visible", this.isOwner && !this.isRecording && this.isNametagVisible);
      this.handRaisedEl = this.handRaisedEl || this.el.querySelector(".hand-raised-id");
      this.handRaisedEl?.setAttribute("visible", this.isHandRaised && this.isNametagVisible);
      animComp(this.handRaisedEl, "scale", this.isHandRaised ? { x: 0.2, y: 0.2, z: 0.2 } : { x: 0, y: 0, z: 0 }, {
        showOnStart: this.isHandRaised,
        hideOnEnd: !this.isHandRaised
      });
      this.updateAvatarModelBBAA();
      const diff =
        Math.abs(tmpVector.subVectors(this.ikRootEl.object3D.position, this.avatarBBAACenter).y) +
        this.avatarBBAASize.y / 2;
      this.handRaisedEl?.setAttribute("position", { y: diff + NAMETAG_OFFSET });
      animComp(this.nametagEl, "position", {
        y: this.isHandRaised ? diff + NAMETAG_OFFSET + NAMETAG_HAND_OFFSET : diff + NAMETAG_OFFSET
      });
      this.updateTyping();
    };
  })(),

  updateTyping() {
    if (this.isLocalPlayerInfo) return;
    this.nametagTypingEl = this.nametagTypingEl || this.el.querySelector(".nametag-typing");
    if (this.nametagTypingEl) {
      for (const dotEl of this.nametagTypingEl.children) {
        dotEl.setAttribute("visible", this.isTyping && !this.isTalking && this.isNametagVisible);
      }
    }
  },

  updateAvatarModelBBAA() {
    if (this.el.querySelector(".AvatarRoot")?.object3D) {
      this.avatarBBAA.setFromObject(this.el.querySelector(".AvatarRoot")?.object3D);
      this.avatarBBAA.getSize(this.avatarBBAASize);
      this.avatarBBAA.getCenter(this.avatarBBAACenter);
    }
  }
});
