import java.util.HashMap;
import java.util.Map;

/**
 * LRU Cache with O(1) get and put.
 *
 * Design:
 * - HashMap maps key -> node for O(1) lookup.
 * - Doubly linked list keeps usage order:
 *   - Most recently used node is near the head.
 *   - Least recently used node is near the tail.
 * - On get: move node to the front.
 * - On put:
 *   - If key exists, update value and move to front.
 *   - If key is new, insert at front.
 *   - If capacity is exceeded, remove from tail and delete from map.
 */
public class LRUCache {
    private static class Node {
        int key;
        int value;
        Node prev;
        Node next;

        Node(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }

    private final int capacity;
    private final Map<Integer, Node> map;
    private final Node head;
    private final Node tail;

    public LRUCache(int capacity) {
        if (capacity <= 0) {
            throw new IllegalArgumentException("Capacity must be greater than 0");
        }

        this.capacity = capacity;
        this.map = new HashMap<>();
        this.head = new Node(0, 0);
        this.tail = new Node(0, 0);

        head.next = tail;
        tail.prev = head;
    }

    public int get(int key) {
        Node node = map.get(key);
        if (node == null) {
            return -1;
        }

        moveToFront(node);
        return node.value;
    }

    public void put(int key, int value) {
        Node node = map.get(key);

        if (node != null) {
            node.value = value;
            moveToFront(node);
            return;
        }

        Node newNode = new Node(key, value);
        map.put(key, newNode);
        addToFront(newNode);

        if (map.size() > capacity) {
            Node lru = removeLast();
            map.remove(lru.key);
        }
    }

    private void moveToFront(Node node) {
        removeNode(node);
        addToFront(node);
    }

    private void addToFront(Node node) {
        node.next = head.next;
        node.prev = head;
        head.next.prev = node;
        head.next = node;
    }

    private void removeNode(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }

    private Node removeLast() {
        Node last = tail.prev;
        removeNode(last);
        return last;
    }

    public static void main(String[] args) {
        LRUCache cache = new LRUCache(2);

        cache.put(1, 1);
        cache.put(2, 2);
        System.out.println(cache.get(1)); // 1

        cache.put(3, 3);                  // evicts key 2
        System.out.println(cache.get(2)); // -1

        cache.put(4, 4);                  // evicts key 1
        System.out.println(cache.get(1)); // -1
        System.out.println(cache.get(3)); // 3
        System.out.println(cache.get(4)); // 4
    }
}
