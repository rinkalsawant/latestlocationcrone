const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

// MongoDB connection configuration
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;

console.log('MongoDB URI:', uri ? 'Set' : 'Not set');
console.log('Database name:', dbName ? dbName : 'Not set');

async function testConnection() {
    try {
        const client = new MongoClient(uri);
        await client.connect();
        console.log('Connected to MongoDB successfully');

        const db = client.db(dbName);
        console.log('Connected to database:', dbName);

        // List all collections
        const collections = await db.listCollections().toArray();
        console.log('Available collections:', collections.map(col => col.name));

        // Check if vehicles collection exists
        const vehiclesCollection = collections.find(col => col.name === 'vehicles');
        if (!vehiclesCollection) {
            console.log('❌ Vehicles collection not found!');
            return;
        }

        console.log('✅ Vehicles collection found');

        // Get total count of vehicles
        const totalVehicles = await db.collection('vehicles').countDocuments();
        console.log(`Total vehicles in collection: ${totalVehicles}`);

        // Get a sample vehicle
        const sampleVehicle = await db.collection('vehicles').findOne({});
        if (sampleVehicle) {
            console.log('Sample vehicle fields:', Object.keys(sampleVehicle));
            console.log('Sample vehicle data:', {
                _id: sampleVehicle._id,
                registrationNumber: sampleVehicle.registrationNumber,
                driverContact: sampleVehicle.driverContact,
                vendorName: sampleVehicle.vendorName
            });
        }

        // Test the query we're using in the cron job
        const vehiclesWithContact = await db.collection('vehicles').find({
            $or: [
                { driverContact: { $exists: true, $ne: null, $ne: "" } },
                { registrationNumber: { $exists: true, $ne: null, $ne: "" } }
            ]
        }).toArray();

        console.log(`Vehicles with driverContact or registrationNumber: ${vehiclesWithContact.length}`);

        if (vehiclesWithContact.length > 0) {
            console.log('Sample vehicles found:');
            vehiclesWithContact.slice(0, 3).forEach((vehicle, index) => {
                console.log(`  ${index + 1}. ID: ${vehicle._id}, Registration: ${vehicle.registrationNumber || 'N/A'}, Contact: ${vehicle.driverContact || 'N/A'}`);
            });
        } else {
            console.log('❌ No vehicles found with the specified criteria');

            // Let's check what vehicles do exist
            const allVehicles = await db.collection('vehicles').find({}).limit(5).toArray();
            console.log('First 5 vehicles in collection:');
            allVehicles.forEach((vehicle, index) => {
                console.log(`  ${index + 1}. ID: ${vehicle._id}`);
                console.log(`     Fields: ${Object.keys(vehicle).join(', ')}`);
                if (vehicle.registrationNumber) console.log(`     Registration: ${vehicle.registrationNumber}`);
                if (vehicle.driverContact) console.log(`     Contact: ${vehicle.driverContact}`);
                console.log('');
            });
        }

        await client.close();
        console.log('Connection closed');

    } catch (error) {
        console.error('Error testing connection:', error);
    }
}

testConnection(); 