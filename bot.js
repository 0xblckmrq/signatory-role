// ================= IMPORTS =================
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const fetch = require("node-fetch");
const express = require("express");
const { ethers } = require("ethers");
const path = require("path");

// ================= CONFIG =================
const ROLE_NAME = "Human ID Verified";
const SBT_CONTRACT = "0x2AA822e264F8cc31A2b9C22f39e5551241e94DfB";
const RPC_URL = "https://mainnet.optimism.io";
const BASE_API = "http://manifest.human.tech/api/covenant/signers-export";
const API_KEY = process.env.WHITELIST_API_KEY;

// ================= TOKEN / IDs =================
const token = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // bot application ID
const GUILD_ID = process.env.GUILD_ID;   // server ID

if (!token || !CLIENT_ID || !GUILD_ID || !API_KEY) {
  console.error("BOT_TOKEN, CLIENT_ID, GUILD_ID, or WHITELIST_API_KEY not set");
  process.exit(1);
}

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ================= EXPRESS =================
const app = express();
app.use(express.static(path.join(__dirname, "public"))); // serve signer.html
app.get("/", (req, res) => res.send("SBT bot is alive"));
app.listen(3000, () => console.log("API running on port 3000"));

// ================= STORAGE =================
const challenges = new Map();

// ================= PROVIDER =================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const ABI = ["function balanceOf(address owner) view returns (uint256)"];

// ================= READY =================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register /verify slash command
  const commands = [
    new SlashCommandBuilder()
      .setName("verify")
      .setDescription("Start Human ID SBT verification")
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("Slash command /verify registered");
  } catch (err) {
    console.error("Error registering slash command:", err);
  }
});

// ================= FETCH WHITELIST =================
async function fetchWhitelist() {
  try {
    const url = `${BASE_API}?apiKey=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json(); // assuming API returns JSON array of wallet addresses
    return data.map(w => w.toLowerCase());
  } catch (err) {
    console.error("Error fetching whitelist:", err);
    return [];
  }
}

// ================= INTERACTIONS =================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "verify") {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.user;
    const guild = interaction.guild;

    // Ask for wallet address
    const filter = m => m.author.id === user.id;
    await interaction.editReply("Please reply with your wallet address (e.g., `0xABCDEF...`) in this channel.");

    const collector = interaction.channel.createMessageCollector({ filter, time: 5 * 60 * 1000, max: 1 });

    collector.on("collect", async (message) => {
      const wallet = message.content.trim().toLowerCase();

      // Fetch whitelist from API
      const whitelist = await fetchWhitelist();
      if (!whitelist.includes(wallet)) return message.reply("❌ Wallet not approved for verification.");

      // Generate challenge
      const challenge = `Verify Discord ${user.id}-${Date.now()}`;
      challenges.set(user.id, { challenge, wallet });

      // Create private verification channel
      try {
        const channel = await guild.channels.create({
          name: `verify-${user.username}`,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory] },
          ],
        });

        await channel.send(
          `✅ **Wallet Verification Started**\n\n` +
          `Sign this message:\n\`${challenge}\`\n\n` +
          `Signer page:\nhttps://role-tfws.onrender.com/signer.html?msg=${encodeURIComponent(challenge)}\n\n` +
          `Then reply:\n\`!signature <your_signature>\``
        );

        // Auto-delete ticket after 10 minutes
        setTimeout(() => {
          if (challenges.has(user.id)) {
            challenges.delete(user.id);
            if (channel) channel.delete().catch(() => {});
          }
        }, 10 * 60 * 1000);

        message.reply(`✅ Verification ticket created! Check your private channel: ${channel}`);
      } catch (err) {
        console.error("CHANNEL ERROR:", err);
        message.reply("❌ Bot lacks permissions to create verification channel.");
      }
    });

    collector.on("end", collected => {
      if (collected.size === 0) interaction.followUp("❌ Verification timed out. Please try again.");
    });
  }
});

// ================= SIGNATURE HANDLER =================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("!signature")) {
    const args = message.content.split(" ");
    if (!args[1]) return message.reply("Use: `!signature <signature>`");

    const signature = args[1];
    const record = challenges.get(message.author.id);
    if (!record) return message.reply("Run `/verify` first or your challenge expired.");

    let walletRecovered;
    try {
      walletRecovered = ethers.verifyMessage(record.challenge, signature);
    } catch {
      return message.reply("❌ Invalid signature.");
    }

    if (walletRecovered.toLowerCase() !== record.wallet) {
      return message.reply("❌ Signature does not match submitted wallet.");
    }

    // Optional: on-chain SBT check
    try {
      const contract = new ethers.Contract(SBT_CONTRACT, ABI, provider);
      const balance = await contract.balanceOf(walletRecovered);
      if (balance === 0n) return message.reply("❌ Wallet does not hold Human ID SBT.");
    } catch {
      return message.reply("❌ Error checking SBT on-chain.");
    }

    // Assign role
    const role = message.guild.roles.cache.find(r => r.name === ROLE_NAME);
    if (!role) return message.reply("Role not found.");
    const member = await message.guild.members.fetch(message.author.id);
    await member.roles.add(role);

    challenges.delete(message.author.id);

    // Delete ticket channel
    if (message.channel.name.startsWith("verify-")) {
      await message.channel.delete().catch(() => {});
    }

    message.reply(`✅ Verified! Wallet: ${walletRecovered}`);
  }
});

// ================= LOGIN =================
client.login(token);
