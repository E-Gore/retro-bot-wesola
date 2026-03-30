class ConnectivityService {
  constructor(config) {
    this.config = config;
    this.lastProbeAt = 0;
    this.cached = config.llm?.apiKey ? "online" : "offline";
  }

  noteSuccess() {
    this.cached = "online";
    this.lastProbeAt = Date.now();
  }

  noteFailure() {
    this.cached = "offline";
    this.lastProbeAt = Date.now();
  }

  async getStatus() {
    if (!this.config.llm?.apiKey) return "offline";
    const now = Date.now();
    if (now - this.lastProbeAt < 10_000) return this.cached;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch("https://clients3.google.com/generate_204", {
        method: "GET",
        signal: controller.signal,
      });
      this.cached = response.ok ? "online" : "offline";
    } catch {
      this.cached = "offline";
    } finally {
      clearTimeout(timeout);
      this.lastProbeAt = now;
    }
    return this.cached;
  }
}

module.exports = { ConnectivityService };
