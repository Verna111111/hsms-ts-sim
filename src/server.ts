import express from 'express';

const app = express();
app.use(express.json());

// New /send-custom endpoint
app.post('/send-custom', (req, res) => {
    const { from, stream, func, items, waitReply } = req.body;

    if (!from || !stream || !func || !items) {
        return res.status(400).send('Missing required fields');
    }

    // Build DataItems dynamically
    const dataItems = items.map(item => ({ ...item, from, stream, func }));

    // Here you can process dataItems as needed, for now, we simply send it back.
    return res.status(200).json({ success: true, dataItems, waitReply });
});

// other existing routes ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
