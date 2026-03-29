class Node:
    def __init__(self, key=0, value=0):
        self.key = key
        self.value = value
        self.prev = None
        self.next = None


class LRUCache:
    """
    Least Recently Used cache.

    get(key)  -> return value if present, else -1
    put(key, value) -> insert/update value and evict least recently used item if needed

    Both operations run in O(1) average time.
    """

    def __init__(self, capacity: int):
        self.capacity = capacity
        self.cache = {}

        self.left = Node()   # LRU sentinel
        self.right = Node()  # MRU sentinel
        self.left.next = self.right
        self.right.prev = self.left

    def _remove(self, node: Node) -> None:
        prev_node = node.prev
        next_node = node.next
        prev_node.next = next_node
        next_node.prev = prev_node

    def _insert(self, node: Node) -> None:
        prev_mru = self.right.prev
        prev_mru.next = node
        node.prev = prev_mru
        node.next = self.right
        self.right.prev = node

    def get(self, key: int) -> int:
        if key not in self.cache:
            return -1

        node = self.cache[key]
        self._remove(node)
        self._insert(node)
        return node.value

    def put(self, key: int, value: int) -> None:
        if key in self.cache:
            self._remove(self.cache[key])

        node = Node(key, value)
        self.cache[key] = node
        self._insert(node)

        if len(self.cache) > self.capacity:
            lru = self.left.next
            self._remove(lru)
            del self.cache[lru.key]
