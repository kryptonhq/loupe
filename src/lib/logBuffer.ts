// A fixed-capacity ring buffer for log lines.
//
// Lives outside React on purpose. Holding the buffer in component state
// meant every arriving line copied the whole array and re-rendered the
// view, so a chatty pod cost more the more of its output you had already
// seen — the cap that bounds memory was exactly what made each line
// expensive. Here, arrival is O(1) and does not imply a render at all;
// the component decides when to look.
//
// Lines are addressed by *absolute* index — how many lines the stream has
// produced before this one — rather than by position in the ring. That
// survives eviction, so a filter's list of matching lines stays valid as
// the window slides, instead of silently shifting by one per dropped
// line.

export class LogBuffer {
  private ring: string[];
  private capacity: number;
  /// Ring slot holding the oldest retained line.
  private startSlot = 0;
  private retained = 0;
  /// Absolute index of the oldest retained line, which is also the
  /// number of lines evicted so far.
  private first = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("capacity must be at least 1");
    this.capacity = capacity;
    this.ring = new Array<string>(capacity);
  }

  /// How many lines are retained.
  get size() {
    return this.retained;
  }

  /// Absolute index of the oldest retained line.
  get firstIndex() {
    return this.first;
  }

  /// Absolute index the next line will be given.
  get nextIndex() {
    return this.first + this.retained;
  }

  /// Lines evicted to stay within capacity. Non-zero means the view is
  /// showing a tail, which the UI says out loud rather than implying.
  get dropped() {
    return this.first;
  }

  /// Appends a line, evicting the oldest if full. Returns its absolute
  /// index.
  push(text: string): number {
    if (this.retained < this.capacity) {
      this.ring[(this.startSlot + this.retained) % this.capacity] = text;
      this.retained += 1;
    } else {
      this.ring[this.startSlot] = text;
      this.startSlot = (this.startSlot + 1) % this.capacity;
      this.first += 1;
    }
    return this.first + this.retained - 1;
  }

  /// The line at an absolute index, or undefined once it has been
  /// evicted or if it has not arrived yet.
  get(index: number): string | undefined {
    if (index < this.first || index >= this.first + this.retained) {
      return undefined;
    }
    return this.ring[(this.startSlot + (index - this.first)) % this.capacity];
  }

  /// A half-open absolute range, clamped to what is retained.
  slice(from: number, to: number): string[] {
    const start = Math.max(from, this.first);
    const end = Math.min(to, this.first + this.retained);
    const out: string[] = [];
    for (let i = start; i < end; i += 1) {
      out.push(this.ring[(this.startSlot + (i - this.first)) % this.capacity]);
    }
    return out;
  }

  /// Everything retained, oldest first.
  toArray(): string[] {
    return this.slice(this.first, this.first + this.retained);
  }

  /// Resets to empty. Absolute indices restart, because the caller is
  /// starting a different stream — carrying them over would imply the
  /// dropped count meant something across the switch.
  clear() {
    this.ring = new Array<string>(this.capacity);
    this.startSlot = 0;
    this.retained = 0;
    this.first = 0;
  }
}
