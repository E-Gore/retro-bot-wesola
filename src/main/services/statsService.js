class StatsService {
  constructor(repository) {
    this.repository = repository;
  }

  getAttractorStats({ connectivityStatus = "offline" } = {}) {
    const stats = this.repository.getAttractorStats();
    const sessionsToday = Number(stats.sessionsToday || 0);
    const completedToday = Number(stats.completedToday || 0);
    const completionRatePct =
      sessionsToday === 0 ? 0 : Math.max(0, Math.min(100, Math.round((completedToday / sessionsToday) * 100)));
    const systemPatiencePct = Math.max(1, 100 - Math.min(96, sessionsToday * 4));

    return {
      ...stats,
      sessionsToday,
      completedToday,
      completionRatePct,
      systemPatiencePct,
      connectivityStatus,
      lastVerdictLabel: stats.lastVerdict || "N/A",
    };
  }
}

module.exports = { StatsService };
