/** An archived thread an agent wrote to again: who wrote, where the reply goes, and Unarchive. */
export function CameBackNote({ name, replyTo, onUnarchive }: { name: string; replyTo: string; onUnarchive: () => void }) {
  return (
    <div className="ib-acts ib-archnote" data-came-back="">
      <span className="ib-st">
        Archived · {name} wrote after you archived it. Your reply goes to {replyTo === name ? 'it' : replyTo}; the thread stays archived.
      </span>
      <button type="button" className="ib-btn" onClick={onUnarchive}>
        Unarchive
      </button>
    </div>
  );
}
