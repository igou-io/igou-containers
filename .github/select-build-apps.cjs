function selectApps(available, requested, manual = false) {
  if (requested === '*') return available;
  return [...new Set(requested.split(/\s+/).filter(Boolean))].filter(app => {
    if (available.includes(app)) return true;
    if (manual) throw new Error(`Unknown app: ${app}`);
    // Change detection includes deleted directories when an image is retired.
    return false;
  });
}
module.exports = { selectApps };
