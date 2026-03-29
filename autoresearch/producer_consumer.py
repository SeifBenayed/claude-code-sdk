import queue
import threading
import time


def producer(buffer: queue.Queue[int], items: int) -> None:
    for item in range(items):
        print(f"produced {item}")
        buffer.put(item)
        time.sleep(0.1)
    buffer.put(None)


def consumer(buffer: queue.Queue[int | None]) -> None:
    while True:
        item = buffer.get()
        try:
            if item is None:
                return
            print(f"consumed {item}")
            time.sleep(0.2)
        finally:
            buffer.task_done()


def main() -> None:
    buffer: queue.Queue[int | None] = queue.Queue(maxsize=3)

    producer_thread = threading.Thread(target=producer, args=(buffer, 10))
    consumer_thread = threading.Thread(target=consumer, args=(buffer,))

    producer_thread.start()
    consumer_thread.start()

    producer_thread.join()
    buffer.join()
    consumer_thread.join()


if __name__ == "__main__":
    main()
