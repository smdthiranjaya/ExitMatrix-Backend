const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const admin = require('firebase-admin');
const serviceAccount = require('./exitmatrix.json');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(express.json());

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'User Position Update API',
      version: '1.0.0',
      description: 'API to update user position on the current map',
    },
    servers: [
      {
        url: 'http://localhost:3000',
      },
    ],
  },
  apis: ['./server.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * /update-position:
 *   post:
 *     summary: Update user position on the current map
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - buildingName
 *               - floorNumber
 *               - row
 *               - column
 *             properties:
 *               buildingName:
 *                 type: string
 *               floorNumber:
 *                 type: integer
 *               row:
 *                 type: integer
 *               column:
 *                 type: integer
 *     responses:
 *       200:
 *         description: User position updated successfully
 *       400:
 *         description: Invalid input or map not found
 *       500:
 *         description: Server error
 */
app.post('/update-position', async (req, res) => {
  try {
    const { buildingName, floorNumber, row, column } = req.body;

    // Validate input
    if (!buildingName || !floorNumber || row === undefined || column === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if building and floor exist
    const buildingDoc = await db.collection('buildings').doc(buildingName).get();
    if (!buildingDoc.exists) {
      return res.status(400).json({ error: 'Building not found' });
    }

    const buildingData = buildingDoc.data();
    const floorKey = `floor_${floorNumber}`;
    if (!buildingData[floorKey]) {
      return res.status(400).json({ error: 'Floor not found' });
    }

    // Get the current map layout
    let mapLayout = buildingData[floorKey].split('|').map(row => row.split(''));

    // Validate row and column
    if (row < 0 || row >= mapLayout.length || column < 0 || column >= mapLayout[0].length) {
      return res.status(400).json({ error: 'Invalid row or column' });
    }

    // Update user position
    mapLayout[row][column] = 'U'; // 'U' for User

    // Convert back to string
    const updatedMapString = mapLayout.map(row => row.join('')).join('|');

    // Update Firestore
    await db.collection('current_map').doc('info').set({
      buildingName: buildingName,
      floorNumber: floorNumber,
      layout: updatedMapString
    });

    res.json({ message: 'User position updated successfully' });
  } catch (error) {
    console.error('Error updating user position:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pathfinding helper functions
function findPosition(map, target) {
    for (let y = 0; y < map.length; y++) {
      for (let x = 0; x < map[y].length; x++) {
        if (map[y][x] === target) return { x, y };
      }
    }
    return null;
  }
  
  function createFireZoneMap(map) {
    const fireZoneMap = map.map(row => [...row]);
    for (let y = 0; y < map.length; y++) {
      for (let x = 0; x < map[y].length; x++) {
        if (map[y][x] === 'F') {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const newX = x + dx;
              const newY = y + dy;
              if (newX >= 0 && newX < map[0].length && newY >= 0 && newY < map.length) {
                if (fireZoneMap[newY][newX] !== 'F' && fireZoneMap[newY][newX] !== '0') {
                  fireZoneMap[newY][newX] = 'Z'; // 'Z' for fire zone
                }
              }
            }
          }
        }
      }
    }
    return fireZoneMap;
  }
  
  function isValidMove(map, fireZoneMap, x, y, allowFireZone) {
    if (x < 0 || x >= map[0].length || y < 0 || y >= map.length) return false;
    if (map[y][x] === '0' || map[y][x] === 'F') return false;
    if (!allowFireZone && fireZoneMap[y][x] === 'Z') return false;
    return true;
  }
  
  function calculateHeuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }
  
  function findPath(map, fireZoneMap, start, end, allowFireZone) {
    const openSet = [{ pos: start, g: 0, h: calculateHeuristic(start, end), f: 0, parent: null, fireZoneCrossings: 0 }];
    const closedSet = new Set();
  
    while (openSet.length > 0) {
      let current = openSet[0];
      let currentIndex = 0;
  
      for (let i = 1; i < openSet.length; i++) {
        if (openSet[i].f < current.f || (openSet[i].f === current.f && openSet[i].fireZoneCrossings < current.fireZoneCrossings)) {
          current = openSet[i];
          currentIndex = i;
        }
      }
  
      if (current.pos.x === end.x && current.pos.y === end.y) {
        let path = [];
        while (current) {
          path.push(current.pos);
          current = current.parent;
        }
        return path.reverse();
      }
  
      openSet.splice(currentIndex, 1);
      closedSet.add(`${current.pos.x},${current.pos.y}`);
  
      const moves = [
        { dx: -1, dy: 0 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: -1 },
        { dx: 0, dy: 1 },
      ];
  
      for (const move of moves) {
        const newX = current.pos.x + move.dx;
        const newY = current.pos.y + move.dy;
  
        if (isValidMove(map, fireZoneMap, newX, newY, allowFireZone)) {
          const newPos = { x: newX, y: newY };
          if (!closedSet.has(`${newX},${newY}`)) {
            const g = current.g + 1;
            const h = calculateHeuristic(newPos, end);
            const f = g + h;
            const fireZoneCrossings = current.fireZoneCrossings + (fireZoneMap[newY][newX] === 'Z' ? 1 : 0);
  
            const existingNode = openSet.find(node => node.pos.x === newX && node.pos.y === newY);
  
            if (!existingNode || g < existingNode.g || (g === existingNode.g && fireZoneCrossings < existingNode.fireZoneCrossings)) {
              if (!existingNode) {
                openSet.push({ pos: newPos, g, h, f, parent: current, fireZoneCrossings });
              } else {
                existingNode.g = g;
                existingNode.f = f;
                existingNode.parent = current;
                existingNode.fireZoneCrossings = fireZoneCrossings;
              }
            }
          }
        }
      }
    }
  
    return null; // No path found
  }
  
  // Firebase listener for layout changes
  db.collection('current_map').doc('info').onSnapshot(async (doc) => {
    const data = doc.data();
    if (!data) return;
  
    const layout = data.layout;
    const map = layout.split('|').map(row => row.split(''));
    const fireZoneMap = createFireZoneMap(map);
  
    const user = findPosition(fireZoneMap, 'U');
    const exit = findPosition(fireZoneMap, 'S');
  
    if (user && exit) {
      let path = findPath(fireZoneMap, fireZoneMap, user, exit, false);
      let warning = '';
  
      if (!path) {
        path = findPath(fireZoneMap, fireZoneMap, user, exit, true);
        if (path) {
          warning = 'WARNING: This path passes through fire zones. Proceed with extreme caution!';
        }
      }
  
      if (path) {
        const instructions = generateUserFriendlyInstructions(path);
        
        // Mark the path on the map
        for (const pos of path) {
          if (fireZoneMap[pos.y][pos.x] !== 'U' && fireZoneMap[pos.y][pos.x] !== 'S' && fireZoneMap[pos.y][pos.x] !== 'F' && fireZoneMap[pos.y][pos.x] !== 'Z') {
            fireZoneMap[pos.y][pos.x] = 'P'; // 'P' for path
          }
        }
  
        // Update the layout in Firebase
        const updatedLayout = fireZoneMap.map(row => row.join('')).join('|');
        await db.collection('current_map').doc('info').update({ 
          layout: updatedLayout,
          warning: warning,
          instructions: instructions,
          currentInstructionIndex: 0
        });
        console.log('Path and user-friendly instructions updated in Firebase', warning ? 'with warning' : '');
      } else {
        console.log('No path found, even allowing fire zone crossings');
        await db.collection('current_map').doc('info').update({ 
          warning: 'ERROR: No path to exit found. Seek immediate assistance!',
          instructions: [],
          currentInstructionIndex: -1
        });
      }
    } else {
      console.log('User or exit not found on the map');
    }
  });

  
  function generateUserFriendlyInstructions(path) {
    const instructions = [];
    let currentDirection = null;
    let distance = 0;
  
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const current = path[i];
      let newDirection;
  
      if (current.x > prev.x) newDirection = 'right';
      else if (current.x < prev.x) newDirection = 'left';
      else if (current.y > prev.y) newDirection = 'down';
      else if (current.y < prev.y) newDirection = 'up';
  
      if (newDirection !== currentDirection) {
        if (currentDirection !== null) {
          let instruction = `Go straight ${distance * 10} meters`;
          if (newDirection === 'left' || newDirection === 'right') {
            instruction += ` and turn ${newDirection}`;
          }
          instructions.push(instruction);
        } else if (newDirection === 'left' || newDirection === 'right') {
          instructions.push(`Turn ${newDirection}`);
        }
        currentDirection = newDirection;
        distance = 1;
      } else {
        distance++;
      }
    }
  
    if (distance > 0) {
      instructions.push(`Go straight ${distance * 10} meters`);
    }
  
    instructions.push("You have reached the exit");
    return instructions;
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Swagger UI available at http://localhost:${PORT}/api-docs`);
  });