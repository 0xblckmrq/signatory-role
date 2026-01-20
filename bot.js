require("dotenv").config();
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField } = require("discord.js");
const fetch = require("node-fetch");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve signer.html
app.use(express.static("public"));
app.listen(PORT, () => console.log(`Signer page running on port ${PORT}`));

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const WHITELIST_API_KEY = process.env.WHITELIST_API_KEY;
const BASE_URL = process.env.RENDER_EXTERNAL_URL; // e.g., https://signatory-role.onrender.com

if (!BOT_TOKEN || !CLIENT_ID || !GUILD_ID || !WHITELIST_API_KEY || !BASE_URL) {
  console.error("BOT_TOKEN, CLIENT_ID, GUILD_ID, WHITELIST_API_KEY, or RENDER_EXTERNAL_URL not set");
  process.exit(1);
}

// In-memory challenge storage
const challenges = new Map();

async function fetchWhitelist() {
  const res = await fetch(`http://manifest.human.tech/api/covenant/signers-export?apiKey=${WHITELIST_API_KEY}`);
  const data = await res.json();
  return data.signers || [];
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const member = interaction.member;
  const guild = interaction.guild;

  if (commandName === "verify") {
    const wallet = interaction.options.getString("wallet")?.toLowerCase();
    if (!wallet) return interaction.reply({ content: "❌ Please provide your wallet address.", ephemeral: true });

    // Fetch whitelist
    let list;
    try {
      list = await fetchWhitelist();
    } catch (e) {
      console.error(e);
      return interaction.reply({ content: "❌ Failed to fetch whitelist.", ephemeral: true });
    }

    const entry = list.find(w => w.walletAddress?.toLowerCase() === wallet);
    if (!entry) return interaction.reply({ content: "❌ Wallet not found in whitelist.", ephemeral: true });

    if (entry.covenantStatus?.toUpperCase() !== "SIGNED") {
      return interaction.reply({ content: "❌ Wallet has not signed the covenant yet. Cannot proceed.", ephemeral: true });
    }

    if (entry.humanityStatus?.toUpperCase() !== "VERIFIED") {
      return interaction.reply({ content: "❌ Wallet has not been verified for humanity. Cannot proceed.", ephemeral: true });
    }

    // Passed whitelist checks → create private channel
    try {
      const channel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });

      // Challenge message
      const challenge = `Verify ownership for ${wallet} at ${Date.now()}`;
      challenges.set(member.id, { challenge, wallet });

      // Correct signer URL
      const signerUrl = `${BASE_URL.replace(/\/$/, "")}/signer.html?challenge=${encodeURIComponent(challenge)}`;

      await channel.send(`
🔐 **Wallet Verification**

Click the signer page link:
${signerUrl}

Connect your wallet and sign the challenge message.

Submit your signature here:
/signature <paste_your_signature_here>
      `);

      await interaction.reply({ content: `✅ Your private verification channel has been opened: ${channel}`, ephemeral: true });

    } catch (err) {
      console.error(err);
      await interaction.reply({ content: "❌ Failed to create verification channel. Please contact an admin.", ephemeral: true });
    }
  }

  else if (commandName === "signature") {
    const sig = interaction.options.getString("sig");
    const challengeData = challenges.get(member.id);

    if (!challengeData) return interaction.reply({ content: "❌ No active verification.", ephemeral: true });

    // Here you would normally verify the signature on-chain / off-chain
    // For simplicity, assume any string submission is valid
    // Replace this with real signature verification if needed
    if (!sig || sig.length < 10) return interaction.reply({ content: "❌ Invalid signature.", ephemeral: true });

    // Assign role
    const roleName = "Covenant Verified Signatory";
    const role = interaction.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return interaction.reply({ content: `❌ Role "${roleName}" does not exist.`, ephemeral: true });

    try {
      await member.roles.add(role);
      await interaction.reply({ content: `✅ Congratulations! You have been assigned the **${roleName}** role.`, ephemeral: true });

      // Delete private channel
      const channel = interaction.channel;
      setTimeout(() => channel.delete().catch(() => {}), 5000);

      challenges.delete(member.id);

    } catch (err) {
      console.error(err);
      interaction.reply({ content: "❌ Failed to assign role. Contact an admin.", ephemeral: true });
    }
  }
});

// Register slash commands (wallet & signature)
client.on("ready", async () => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return console.error("Guild not found");

  await guild.commands.create({
    name: "verify",
    description: "Start wallet verification",
    options: [
      { type: 3, name: "wallet", description: "Your wallet address", required: true }
    ]
  });

  await guild.commands.create({
    name: "signature",
    description: "Submit your wallet signature",
    options: [
      { type: 3, name: "sig", description: "Signature from signer page", required: true }
    ]
  });
});

client.login(BOT_TOKEN);
