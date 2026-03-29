public class TSPBranchAndBound4Cities {
    static final int INF = 1_000_000;
    static int bestCost = INF;
    static int[] bestPath = new int[5];

    public static void main(String[] args) {
        int[][] cost = {
            {INF, 10, 15, 20},
            {10, INF, 35, 25},
            {15, 35, INF, 30},
            {20, 25, 30, INF}
        };

        boolean[] visited = new boolean[4];
        int[] path = new int[5];
        path[0] = 0;
        visited[0] = true;

        branchAndBound(cost, visited, path, 1, 0);

        System.out.println("Minimum tour cost: " + bestCost);
        System.out.print("Best tour: ");
        for (int i = 0; i < bestPath.length; i++) {
            System.out.print(bestPath[i]);
            if (i < bestPath.length - 1) {
                System.out.print(" -> ");
            }
        }
        System.out.println();
    }

    static void branchAndBound(int[][] cost, boolean[] visited, int[] path, int level, int currentCost) {
        if (level == 4) {
            int tourCost = currentCost + cost[path[level - 1]][0];
            if (tourCost < bestCost) {
                bestCost = tourCost;
                System.arraycopy(path, 0, bestPath, 0, 4);
                bestPath[4] = 0;
            }
            return;
        }

        int bound = currentCost + lowerBound(cost, visited, path, level);
        if (bound >= bestCost) {
            return;
        }

        int last = path[level - 1];
        for (int city = 1; city < 4; city++) {
            if (!visited[city]) {
                visited[city] = true;
                path[level] = city;
                branchAndBound(cost, visited, path, level + 1, currentCost + cost[last][city]);
                visited[city] = false;
            }
        }
    }

    static int lowerBound(int[][] cost, boolean[] visited, int[] path, int level) {
        int estimate = 0;

        int last = path[level - 1];
        int minFromLast = INF;
        for (int j = 0; j < 4; j++) {
            if (!visited[j] && cost[last][j] < minFromLast) {
                minFromLast = cost[last][j];
            }
        }
        if (minFromLast != INF) {
            estimate += minFromLast;
        }

        for (int i = 0; i < 4; i++) {
            if (!visited[i]) {
                int minEdge = INF;
                for (int j = 0; j < 4; j++) {
                    if (i != j && (!visited[j] || j == 0) && cost[i][j] < minEdge) {
                        minEdge = cost[i][j];
                    }
                }
                estimate += minEdge;
            }
        }

        return estimate;
    }
}
