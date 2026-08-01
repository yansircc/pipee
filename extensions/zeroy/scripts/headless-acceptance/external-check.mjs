const pageFailure = (page) =>
  page.status !== page.expectedStatus || page.error !== null || page.brokenLinks.length !== 0;

export const externalCheckFailures = (pages) =>
  pages.filter(pageFailure).map((page) => ({
    scenarioId: page.scenarioId,
    expectedStatus: page.expectedStatus,
    status: page.status,
    error: page.error,
    brokenLinks: page.brokenLinks.length,
  }));
