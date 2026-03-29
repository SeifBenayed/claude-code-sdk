# Benchmark: Claude vs Cloclo — 100 Rounds

## Rules
- Score starts at **0**
- For each query: run via `node ~/claude-tool-loop/claude-native.mjs -p "<query>"`
- Compare cloclo's answer to Claude's answer
- **+1** if cloclo is same quality or better
- **-1** if cloclo is bad/wrong
- Final score out of 100

## Scoring Guide
| Criteria | +1 | -1 |
|----------|----|----|
| Factually correct | ✅ | ❌ |
| Complete answer | ✅ | ❌ |
| Good formatting | ✅ | ❌ |
| Code runs correctly | ✅ | ❌ |
| Creative quality | ✅ (subjective tie = +1) | ❌ |

---

## Queries (100)

### Category 1: Factual Knowledge (1-10)
1. What is the speed of light in m/s?
2. Who wrote "1984"?
3. What is the largest ocean on Earth?
4. How many bones are in the adult human body?
5. What year did the Berlin Wall fall?
6. What is the chemical formula for water?
7. Who painted the Mona Lisa?
8. What is the smallest country in the world by area?
9. What planet is known as the Red Planet?
10. What is the boiling point of water in Celsius at sea level?

### Category 2: Math & Logic (11-20)
11. What is 247 * 89 - 1023?
12. What is the derivative of x^3 + 2x^2 - 5x + 7?
13. Solve for x: 3x + 7 = 22
14. What is the integral of sin(x)?
15. What is 15! (15 factorial)?
16. Is 997 a prime number?
17. What is the sum of the first 100 positive integers?
18. Convert 0xFF to decimal
19. What is log base 2 of 1024?
20. If a train travels 120km in 1.5 hours, what is its speed in m/s?

### Category 3: Coding — JavaScript (21-30)
21. Write a function to check if a string is a palindrome
22. Implement a debounce function
23. Write a function to flatten a nested array
24. Implement a simple Promise.all from scratch
25. Write a function to deep clone an object
26. Implement binary search in JavaScript
27. Write a function to find the longest common prefix in an array of strings
28. Implement a basic LRU cache
29. Write a function to convert RGB to HEX
30. Implement Array.prototype.reduce from scratch

### Category 4: Coding — Python (31-40)
31. Write a Python function to generate Fibonacci numbers using a generator
32. Implement a decorator that caches function results (memoize)
33. Write a function to find all permutations of a string
34. Implement a basic linked list with insert and delete
35. Write a context manager for timing code execution
36. Implement merge sort in Python
37. Write a function to validate balanced parentheses
38. Implement a simple producer-consumer with threading
39. Write a function to find the longest palindromic substring
40. Implement a trie (prefix tree) in Python

### Category 5: System Design & Architecture (41-50)
41. Explain the difference between monolith and microservices in 3 sentences
42. What is CAP theorem? Explain briefly
43. How does a load balancer work?
44. Explain event-driven architecture in one paragraph
45. What is database sharding and when would you use it?
46. Explain the pub/sub pattern
47. What is the difference between horizontal and vertical scaling?
48. Explain CQRS in simple terms
49. What are the trade-offs of using a message queue?
50. Explain the circuit breaker pattern

### Category 6: DevOps & Infrastructure (51-60)
51. What is the difference between Docker and a VM?
52. Explain what a Kubernetes pod is
53. What does CI/CD stand for and why is it important?
54. Explain the difference between blue-green and canary deployments
55. What is Infrastructure as Code?
56. Explain how DNS resolution works step by step
57. What is a reverse proxy and how is it different from a forward proxy?
58. Explain what a service mesh is
59. What are the 12-factor app principles? List them
60. Explain the difference between symmetric and asymmetric encryption

### Category 7: Data Structures & Algorithms (61-70)
61. Explain the difference between a stack and a queue
62. What is the time complexity of inserting into a balanced BST?
63. Explain Dijkstra's algorithm in simple terms
64. What is a hash collision and how do you handle it?
65. Explain the difference between BFS and DFS
66. What is dynamic programming? Give a one-sentence definition
67. Explain the difference between a min-heap and a max-heap
68. What is the amortized time complexity of appending to a dynamic array?
69. Explain what a bloom filter is and when to use it
70. What is topological sorting and when is it used?

### Category 8: Web & Networking (71-80)
71. Explain the difference between HTTP/1.1, HTTP/2, and HTTP/3
72. What is CORS and why does it exist?
73. Explain how WebSockets work vs HTTP polling
74. What is the difference between cookies, localStorage, and sessionStorage?
75. Explain what a CDN does
76. What are the HTTP methods and their intended uses?
77. Explain the OAuth 2.0 authorization code flow
78. What is the difference between REST and GraphQL?
79. Explain what TLS handshake involves
80. What is Server-Sent Events (SSE) and when to use it over WebSockets?

### Category 9: Creative & Language (81-90)
81. Write a haiku about debugging
82. Explain quantum computing to a 10-year-old
83. Write a short analogy comparing Git branches to something in real life
84. Translate "The quick brown fox jumps over the lazy dog" to French
85. Write a limerick about JavaScript
86. Explain the internet to someone from the 1800s in 3 sentences
87. Come up with 3 creative variable names for a function that calculates tax
88. Write a commit message for "fixed a bug where users could log in with an empty password"
89. Explain recursion using a real-world analogy
90. Write a short joke about CSS

### Category 10: Edge Cases & Tricky Questions (91-100)
91. What is 0.1 + 0.2 in JavaScript and why?
92. What is the difference between == and === in JavaScript?
93. What happens when you type a URL in the browser and press Enter?
94. Why is NaN !== NaN in JavaScript?
95. What is the output of `typeof null` in JavaScript and why?
96. Explain the difference between concurrency and parallelism
97. What is a race condition? Give a simple example
98. Why should you never use eval() in JavaScript?
99. What is the halting problem and why does it matter?
100. Explain why you can't reliably sort an array with `arr.sort()` without a comparator in JS

---

## Execution Template

Run queries in batches of 5 for efficiency:

```bash
# Batch example
node ~/claude-tool-loop/claude-native.mjs -p "query here" 2>/dev/null
```

## Scorecard

| Round | Category | Score | Notes |
|-------|----------|-------|-------|
| 1-10 | Factual | /10 | |
| 11-20 | Math | /10 | |
| 21-30 | JS Code | /10 | |
| 31-40 | Python | /10 | |
| 41-50 | System Design | /10 | |
| 51-60 | DevOps | /10 | |
| 61-70 | DS & Algo | /10 | |
| 71-80 | Web & Net | /10 | |
| 81-90 | Creative | /10 | |
| 91-100 | Edge Cases | /10 | |
| **TOTAL** | | **/100** | |
