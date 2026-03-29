class HashMap {
  constructor(bucketCount = 16) {
    this.buckets = Array.from({ length: bucketCount }, () => []);
    this.size = 0;
  }

  hash(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return hash % this.buckets.length;
  }

  set(key, value) {
    if (typeof key !== 'string') {
      throw new TypeError('Key must be a string');
    }
    if (!Number.isInteger(value)) {
      throw new TypeError('Value must be an integer');
    }

    const index = this.hash(key);
    const bucket = this.buckets[index];

    for (const entry of bucket) {
      if (entry.key === key) {
        entry.value = value;
        return;
      }
    }

    bucket.push({ key, value });
    this.size++;
  }

  get(key) {
    const index = this.hash(key);
    const bucket = this.buckets[index];

    for (const entry of bucket) {
      if (entry.key === key) {
        return entry.value;
      }
    }

    return undefined;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    const index = this.hash(key);
    const bucket = this.buckets[index];

    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].key === key) {
        bucket.splice(i, 1);
        this.size--;
        return true;
      }
    }

    return false;
  }
}

const map = new HashMap();
map.set('apple', 3);
map.set('banana', 7);
map.set('apple', 10);

console.log(map.get('apple'));   // 10
console.log(map.get('banana'));  // 7
console.log(map.has('pear'));    // false
console.log(map.delete('banana')); // true
console.log(map.get('banana'));  // undefined
console.log(map.size);           // 1
