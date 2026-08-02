import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import client from "prom-client"; // 📊 Import Prometheus client

const PORT = 8080;
const HOST = '0.0.0.0';

// 📊 Initialize Prometheus metrics gathering
client.collectDefaultMetrics({ register: client.register });

// track volume, status code, latency
const httpRequestDurationMicroseconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'], // 🏷️ These allow us to split data by 2xx/4xx/5xx!
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5] // Latency buckets
});


// 🔗 DATABASE CONNECTION
// Fallback to the environment variable we provided in the K8s deployment file!
const url = process.env.MONGO_URL || 'mongodb://db:27017';
const mongoClient = new MongoClient(url);
const dbName = 'namesDB';
let db, namesCollection;

// Connect to MongoDB before starting the Express server
async function initDatabase() {
    try {
        await mongoClient.connect();
        db = mongoClient.db(dbName);
        namesCollection = db.collection('names');
        console.log("Connected successfully to MongoDB");
    } catch (err) {
        console.error("Database connection failed:", err);
    }
}
initDatabase();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// middleware to intercept all incoming traffic.
app.use((req, res, next) => {
    const start = process.hrtime();

    // When the response finishes processing, record the metrics
    res.on('finish', () => {
        const diff = process.hrtime(start);
        const durationInSeconds = diff[0] + diff[1] / 1e9;
        
        // Don't track the scrapers hitting /metrics or asset noise
        if (req.path !== '/metrics') {
            httpRequestDurationMicroseconds
                .labels(req.method, req.path, res.statusCode)
                .observe(durationInSeconds);
        }
    });

    next();
});

// 📊 NEW: Expose the /metrics endpoint for Prometheus to scrape
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
});

// 📄 READ: Fetch all names from MongoDB and render the HTML
app.get('/', async (req, res) => {
    const nameDatabase = await namesCollection.find({}).toArray();

    let listItems = nameDatabase.map(user => `
        <li style="margin-bottom: 10px;">
            <strong>${user.name}</strong> 
            <!-- Edit Form -->
            <form action="/edit/${user._id}" method="POST" style="display:inline; margin-left: 10px;">
                <input type="text" name="newName" placeholder="New name" required />
                <button type="submit">Edit</button>
            </form>
            <!-- Delete Form -->
            <form action="/delete/${user._id}" method="POST" style="display:inline; margin-left: 5px;">
                <button type="submit" style="color: red;">Delete</button>
            </form>
        </li>
    `).join('');

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Docker + MongoDB</title></head>
        <body style="font-family: Arial, sans-serif; margin: 40px;">
            <h2>📝 MongoDB Name Manager</h2>
            <form action="/create" method="POST" style="margin-bottom: 20px;">
                <input type="text" name="username" placeholder="Enter a name" required style="padding: 5px;"/>
                <button type="submit" style="padding: 5px 10px;">Add Name</button>
            </form>
            <h3>Current Names in MongoDB:</h3>
            <ul>${listItems}</ul>
        </body>
        </html>
    `);
});

// ➕ CREATE: Insert a new document into MongoDB
app.post('/create', async (req, res) => {
    const newName = req.body.username;
    await namesCollection.insertOne({ name: newName }); 
    res.redirect('/');
});

// ✏️ UPDATE: Modify an existing document by its ID
app.post('/edit/:id', async (req, res) => {
    const targetId = req.params.id;
    const updatedName = req.body.newName;

    await namesCollection.updateOne(
        { _id: new ObjectId(targetId) },
        { $set: { name: updatedName } }
    );

    res.redirect('/');
});

// ❌ DELETE: Remove a document by its ID
app.post('/delete/:id', async (req, res) => {
    const targetId = req.params.id;
    await namesCollection.deleteOne({ _id: new ObjectId(targetId) });
    res.redirect('/');
});

app.listen(PORT, HOST, () => {
    console.log(`Running on http://${HOST}:${PORT}`);
});