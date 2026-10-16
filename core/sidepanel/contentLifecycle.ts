/** BFCache restores an existing content script rather than running it again. */
export function subscribeToRepositoryReturn(
  target: Window,
  onReturn: () => void,
): () => void {
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) onReturn()
  }
  target.addEventListener("pageshow", onPageShow)
  return () => target.removeEventListener("pageshow", onPageShow)
}
