/** Catalog presentation has no local identity, prompt or asset fallback. */
export function templateRoute({ templateId }) {
  if (templateId === '' || templateId == null) return '/pages/create/index'
  return `/pages/create/index?template=${encodeURIComponent(templateId)}`
}
export function templateLabels({ template }) {
  const display = template.displayConfig
  return {
    category: display.categoryName || '',
    label: display.tags.find((tag) => tag.id === display.primaryTagId)?.name || ''
  }
}
