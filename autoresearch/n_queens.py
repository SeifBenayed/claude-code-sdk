def solve_n_queens(n):
    results = []
    cols = set()
    diag1 = set()
    diag2 = set()
    board = [["."] * n for _ in range(n)]

    def backtrack(row):
        if row == n:
            results.append(["".join(r) for r in board])
            return

        for col in range(n):
            if col in cols or (row - col) in diag1 or (row + col) in diag2:
                continue

            cols.add(col)
            diag1.add(row - col)
            diag2.add(row + col)
            board[row][col] = "Q"

            backtrack(row + 1)

            board[row][col] = "."
            cols.remove(col)
            diag1.remove(row - col)
            diag2.remove(row + col)

    backtrack(0)
    return results


if __name__ == "__main__":
    n = 4
    for solution in solve_n_queens(n):
        for row in solution:
            print(row)
        print()
