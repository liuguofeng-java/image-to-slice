async function testModelConfig(config, runners) {
  const results = {};
  for (const task of config.tasks) {
    runners.signal?.throwIfAborted();
    const testedAt = (runners.now?.() || new Date()).toISOString();
    try {
      const outcome = await runners[task]();
      runners.signal?.throwIfAborted();
      results[task] = {
        status: "success",
        ...(task === "inpaint" ? {
          maskMode: outcome.maskMode,
          nativeMaskSupported: outcome.maskMode === "native-mask"
        } : {}),
        testedAt
      };
    } catch (error) {
      if (runners.signal?.aborted || error?.name === 'AbortError') throw error;
      results[task] = {
        status: "failed",
        error: String(error?.message || error).slice(0, 500),
        testedAt
      };
    }
  }
  return {
    configId: config.id,
    results
  };
}

module.exports = {
  testModelConfig
};
