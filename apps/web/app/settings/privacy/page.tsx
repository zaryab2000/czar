export default function PrivacyPage() {
  return (
    <section className="page-stack">
      <h1 className="czar-title">Privacy</h1>
      <p>
        Raw work data stays on your computer. Only redacted excerpts are sent to compile your Work
        Soul, through a Czar relay that stores nothing. Objectives sent to Czar&apos;s server are
        redacted first.
      </p>
      <p>
        <a href="/settings/devices">Manage paired devices</a>
      </p>
    </section>
  );
}
