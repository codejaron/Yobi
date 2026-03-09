(function (global) {
  const EMOTION_KEYS = ["mood", "energy", "connection", "curiosity", "confidence", "irritation"];
  const OPEN_EYE_SLOTS = new Set(["eyeOpenL", "eyeOpenR"]);
  const ANGLE_LIMIT_SLOTS = new Set(["angleY", "angleZ"]);

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const safeNumber = (value, fallback = 0) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const normalizeParameterKey = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const normalizeEmotion = (input, defaults) => ({
    mood: clamp(safeNumber(input && input.mood, defaults.mood), -1, 1),
    energy: clamp(safeNumber(input && input.energy, defaults.energy), 0, 1),
    connection: clamp(safeNumber(input && input.connection, defaults.connection), 0, 1),
    curiosity: clamp(safeNumber(input && input.curiosity, defaults.curiosity), 0, 1),
    confidence: clamp(safeNumber(input && input.confidence, defaults.confidence), 0, 1),
    irritation: clamp(safeNumber(input && input.irritation, defaults.irritation), 0, 1)
  });
  const cloneEmotion = (emotion) => ({
    mood: emotion.mood,
    energy: emotion.energy,
    connection: emotion.connection,
    curiosity: emotion.curiosity,
    confidence: emotion.confidence,
    irritation: emotion.irritation
  });
  const approachExp = (current, target, perSecond, dtMs) => {
    const dtSeconds = Math.max(0, dtMs) / 1000;
    if (dtSeconds <= 0 || perSecond <= 0) {
      return target;
    }
    const alpha = 1 - Math.exp(-perSecond * dtSeconds);
    return current + (target - current) * alpha;
  };
  const lerpRange = (min, max, factor) => min + (max - min) * clamp(factor, 0, 1);
  const randomBetween = (min, max) => min + Math.random() * Math.max(0, max - min);

  function decodeConfigBase64(value) {
    if (!value) {
      return null;
    }

    try {
      const binary = atob(String(value));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  function listParameterIds(coreModel, count) {
    const idsFromMethod =
      typeof coreModel.getParameterIds === "function" ? coreModel.getParameterIds() : null;
    const idsFromField = Array.isArray(coreModel._parameterIds)
      ? coreModel._parameterIds
      : Array.isArray(coreModel.parameters && coreModel.parameters.ids)
        ? coreModel.parameters.ids
        : [];
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const fromMethod = idsFromMethod && typeof idsFromMethod[index] === "string" ? idsFromMethod[index] : null;
      const fromField = typeof idsFromField[index] === "string" ? idsFromField[index] : null;
      result.push(fromMethod || fromField || "");
    }
    return result;
  }

  function resolveModelCapabilities(coreModel, config) {
    if (!coreModel || typeof coreModel.getParameterCount !== "function") {
      return {
        parameters: [],
        slots: {},
        slotCount: 0
      };
    }

    const count = safeNumber(coreModel.getParameterCount(), 0);
    const ids = listParameterIds(coreModel, count);
    const parameters = [];
    const byNormalizedId = new Map();

    for (let index = 0; index < count; index += 1) {
      const id = typeof ids[index] === "string" && ids[index] ? ids[index] : `param_${index}`;
      const parameter = {
        id,
        index,
        min: safeNumber(coreModel.getParameterMinimumValue(index), -1),
        max: safeNumber(coreModel.getParameterMaximumValue(index), 1),
        defaultValue: safeNumber(coreModel.getParameterDefaultValue(index), 0),
        currentValue: safeNumber(coreModel.getParameterValueByIndex(index), 0)
      };
      parameters.push(parameter);
      byNormalizedId.set(normalizeParameterKey(id), parameter);
    }

    const slots = {};
    const aliases = config && config.aliases ? config.aliases : {};
    for (const [slot, slotAliases] of Object.entries(aliases)) {
      const candidates = Array.isArray(slotAliases) ? slotAliases : [];
      for (const alias of candidates) {
        const parameter = byNormalizedId.get(normalizeParameterKey(alias));
        if (!parameter) {
          continue;
        }
        slots[slot] = parameter;
        break;
      }
    }

    return {
      parameters,
      slots,
      slotCount: Object.keys(slots).length
    };
  }

  function computeFeatures(emotion) {
    const connectionSigned = clamp(emotion.connection * 2 - 1, -1, 1);
    const curiositySigned = clamp(emotion.curiosity * 2 - 1, -1, 1);
    const confidenceSigned = clamp(emotion.confidence * 2 - 1, -1, 1);
    const energySigned = clamp(emotion.energy * 2 - 1, -1, 1);
    return {
      mood: emotion.mood,
      moodPositive: Math.max(0, emotion.mood),
      moodNegative: Math.max(0, -emotion.mood),
      energySigned,
      connectionSigned,
      connectionPositive: Math.max(0, connectionSigned),
      curiositySigned,
      curiosityPositive: Math.max(0, curiositySigned),
      confidenceSigned,
      confidenceNegative: Math.max(0, -confidenceSigned),
      irritation: emotion.irritation
    };
  }

  function createBlinkController(config) {
    const blink = {
      phase: "idle",
      remainingMs: randomBetween(config.intervalMinMs, config.intervalMaxMs),
      factor: 1
    };

    return {
      reset() {
        blink.phase = "idle";
        blink.remainingMs = randomBetween(config.intervalMinMs, config.intervalMaxMs);
        blink.factor = 1;
      },
      update(dtMs) {
        const nextDelta = Math.max(0, dtMs);
        blink.remainingMs -= nextDelta;
        while (blink.remainingMs <= 0) {
          if (blink.phase === "idle") {
            blink.phase = "closing";
            blink.remainingMs += config.closeMs;
            blink.factor = 1;
            continue;
          }
          if (blink.phase === "closing") {
            blink.phase = "hold";
            blink.remainingMs += config.holdMs;
            blink.factor = 0;
            continue;
          }
          if (blink.phase === "hold") {
            blink.phase = "opening";
            blink.remainingMs += config.openMs;
            blink.factor = 0;
            continue;
          }
          blink.phase = "idle";
          blink.remainingMs += randomBetween(config.intervalMinMs, config.intervalMaxMs);
          blink.factor = 1;
        }

        if (blink.phase === "closing") {
          blink.factor = clamp(blink.remainingMs / Math.max(1, config.closeMs), 0, 1);
          return;
        }
        if (blink.phase === "hold") {
          blink.factor = 0;
          return;
        }
        if (blink.phase === "opening") {
          blink.factor = clamp(1 - blink.remainingMs / Math.max(1, config.openMs), 0, 1);
          return;
        }
        blink.factor = 1;
      },
      getOpenFactor() {
        return blink.factor;
      }
    };
  }

  function impulseEnvelope(ageMs, durationMs) {
    if (durationMs <= 0 || ageMs < 0 || ageMs >= durationMs) {
      return 0;
    }
    const attackMs = Math.min(140, Math.max(60, durationMs * 0.22));
    if (ageMs <= attackMs) {
      return clamp(ageMs / Math.max(1, attackMs), 0, 1);
    }
    return clamp(1 - (ageMs - attackMs) / Math.max(1, durationMs - attackMs), 0, 1);
  }

  function resolveTemplate(config, name) {
    if (!config || !config.impulses || !name) {
      return null;
    }
    return config.impulses[name] || null;
  }

  function createPetEmotionRenderer(input) {
    const model = input && input.model;
    const config = input && input.config;
    const debugLog = input && typeof input.debugLog === "function" ? input.debugLog : () => {};
    const internalModel = model && model.internalModel ? model.internalModel : null;
    const coreModel = internalModel && internalModel.coreModel ? internalModel.coreModel : null;
    if (!model || !internalModel || !coreModel || !config) {
      return null;
    }

    const capabilities = resolveModelCapabilities(coreModel, config);
    const defaultEmotion = normalizeEmotion(config.defaultEmotion, config.defaultEmotion);
    let targetEmotion = cloneEmotion(defaultEmotion);
    let currentEmotion = cloneEmotion(defaultEmotion);
    let lipSyncOpen = 0;
    let warmupRemainingMs = safeNumber(config.smoothing && config.smoothing.warmupMs, 900);
    let rendererFailed = false;
    const impulses = new Map();
    const blink = createBlinkController(config.blink || {
      intervalMinMs: 2800,
      intervalMaxMs: 5200,
      closeMs: 90,
      holdMs: 45,
      openMs: 140
    });

    const originalUpdate = internalModel.update.bind(internalModel);
    internalModel.update = (dt, now) => {
      originalUpdate(dt, now);
      if (rendererFailed) {
        return;
      }
      try {
        updateAfterInternalModel(dt, now);
      } catch (error) {
        rendererFailed = true;
        debugLog("emotion-runtime:error", {
          message: error && error.message ? String(error.message) : String(error)
        });
      }
    };

    function setTargetEmotion(nextEmotion) {
      targetEmotion = normalizeEmotion(nextEmotion, defaultEmotion);
    }

    function triggerImpulse(name, options) {
      const template = resolveTemplate(config, name);
      if (!template) {
        return;
      }
      const intensity = clamp(
        safeNumber(options && options.intensity, template.intensity),
        0,
        1.25
      );
      const durationMs = Math.max(80, safeNumber(options && options.durationMs, template.durationMs));
      impulses.set(name, {
        name,
        intensity,
        durationMs,
        ageMs: 0
      });
    }

    function setLipSyncOpen(value) {
      lipSyncOpen = clamp(safeNumber(value, 0), 0, 1);
    }

    function releaseLipSync(dtMs) {
      const releasePerSecond = safeNumber(config.lipSync && config.lipSync.releasePerSecond, 9);
      lipSyncOpen = approachExp(lipSyncOpen, 0, releasePerSecond, dtMs);
    }

    function reset(nextEmotion) {
      targetEmotion = normalizeEmotion(nextEmotion || defaultEmotion, defaultEmotion);
      currentEmotion = cloneEmotion(defaultEmotion);
      impulses.clear();
      warmupRemainingMs = safeNumber(config.smoothing && config.smoothing.warmupMs, 900);
      lipSyncOpen = 0;
      blink.reset();
      rendererFailed = false;
    }

    function destroy() {
      internalModel.update = originalUpdate;
      impulses.clear();
    }

    function hasSlot(slot) {
      return Boolean(capabilities.slots && capabilities.slots[slot]);
    }

    function updateAfterInternalModel(dtMs) {
      const nextDeltaMs = Math.max(0, safeNumber(dtMs, 0));
      advanceEmotion(nextDeltaMs);
      advanceImpulses(nextDeltaMs);
      blink.update(nextDeltaMs);
      releaseLipSync(nextDeltaMs);
      applyControlledSlots();
    }

    function advanceEmotion(dtMs) {
      const useWarmup = warmupRemainingMs > 0;
      const rate = safeNumber(
        useWarmup
          ? config.smoothing && config.smoothing.warmupPerSecond
          : config.smoothing && config.smoothing.followPerSecond,
        useWarmup ? 12 : 7.2
      );
      for (const key of EMOTION_KEYS) {
        currentEmotion[key] = approachExp(currentEmotion[key], targetEmotion[key], rate, dtMs);
      }
      warmupRemainingMs = Math.max(0, warmupRemainingMs - dtMs);
    }

    function advanceImpulses(dtMs) {
      for (const [name, impulse] of impulses.entries()) {
        impulse.ageMs += dtMs;
        if (impulse.ageMs >= impulse.durationMs) {
          impulses.delete(name);
        }
      }
    }

    function getImpulseContribution(slot) {
      let total = 0;
      for (const impulse of impulses.values()) {
        const template = resolveTemplate(config, impulse.name);
        if (!template || !template.slots || typeof template.slots[slot] !== "number") {
          continue;
        }
        total += template.slots[slot] * impulse.intensity * impulseEnvelope(impulse.ageMs, impulse.durationMs);
      }
      return total;
    }

    function resolveMappedValue(slot, parameter, features) {
      const mapping = config.mappings && config.mappings[slot];
      if (!mapping) {
        return parameter.defaultValue;
      }
      let value = safeNumber(mapping.baseValue, parameter.defaultValue);
      const weights = mapping.weights || {};
      for (const [featureName, weight] of Object.entries(weights)) {
        value += safeNumber(features[featureName], 0) * safeNumber(weight, 0);
      }
      if (typeof mapping.softMin === "number") {
        value = Math.max(mapping.softMin, value);
      }
      if (typeof mapping.softMax === "number") {
        value = Math.min(mapping.softMax, value);
      }
      if (ANGLE_LIMIT_SLOTS.has(slot)) {
        const limit = slot === "angleY"
          ? safeNumber(config.angleLimits && config.angleLimits.angleY, 3)
          : safeNumber(config.angleLimits && config.angleLimits.angleZ, 5);
        value = clamp(value, -Math.abs(limit), Math.abs(limit));
      }
      return clamp(value, parameter.min, parameter.max);
    }

    function applyControlledSlots() {
      const features = computeFeatures(currentEmotion);
      for (const [slot, parameter] of Object.entries(capabilities.slots)) {
        if (!parameter || !parameter.id) {
          continue;
        }
        let nextValue = resolveMappedValue(slot, parameter, features);
        if (slot === "mouthOpen") {
          nextValue = lerpRange(parameter.min, parameter.max, lipSyncOpen);
        } else if (OPEN_EYE_SLOTS.has(slot)) {
          const desired = clamp(nextValue + getImpulseContribution(slot), parameter.min, parameter.max);
          const blinkFactor = blink.getOpenFactor();
          nextValue = parameter.min + (desired - parameter.min) * blinkFactor;
        } else {
          nextValue = clamp(nextValue + getImpulseContribution(slot), parameter.min, parameter.max);
        }
        coreModel.setParameterValueById(parameter.id, nextValue);
      }
    }

    return {
      capabilities,
      destroy,
      hasSlot,
      reset,
      setLipSyncOpen,
      setTargetEmotion,
      triggerImpulse
    };
  }

  global.YobiPetEmotionRuntime = {
    createPetEmotionRenderer,
    decodeConfigBase64
  };
})(window);
