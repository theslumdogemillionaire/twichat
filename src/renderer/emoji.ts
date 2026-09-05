import { m } from '../shared/i18n'

export interface Emoji {
  char: string
  name: string
  keywords: string[]
  group: string
}

/**
 * Compact table: one line per emoji, "character shortcode keywords…", so the search stays
 * local and offline. The shortcode is an identifier: `:joy:` stays `:joy:` in every language,
 * that is what gets typed. Only the search keywords change, through the catalog.
 */
const TABLE: Array<[string, string]> = [
  ['faces', `😀 grinning
😃 smiley
😄 smile
😁 grin
😆 laughing
😅 sweat_smile
😂 joy
🤣 rofl
🙂 slight_smile
🙃 upside_down
😉 wink
😊 blush
😇 innocent
🥰 smiling_hearts
😍 heart_eyes
😘 kiss
😋 yum
😜 stuck_out_tongue_wink
🤪 zany
🤗 hugs
🤭 hand_over_mouth
🤫 shushing
🤔 thinking
🤨 raised_eyebrow
😐 neutral
😑 expressionless
😶 no_mouth
😏 smirk
😒 unamused
🙄 roll_eyes
😬 grimacing
😌 relieved
😔 pensive
😪 sleepy
😴 sleeping
🥱 yawning
😷 mask
🤒 thermometer
🤢 nauseated
🤮 vomiting
🥵 hot
🥶 cold
😵 dizzy
🤯 exploding_head
🤠 cowboy
🥳 partying
😎 sunglasses
🤓 nerd
🧐 monocle
😕 confused
😟 worried
🙁 frowning
😮 open_mouth
😲 astonished
🥺 pleading
😨 fearful
😰 anxious
😢 cry
😭 sob
😱 scream
😖 confounded
😞 disappointed
😩 weary
😫 tired
😤 triumph
😡 rage
😠 angry
🤬 cursing
😈 smiling_imp
👿 imp
💀 skull
💩 poop
🤡 clown
👻 ghost
👽 alien
🤖 robot
😺 smiley_cat
😹 joy_cat
😻 heart_eyes_cat`],
  ['gestures', `👍 thumbsup
👎 thumbsdown
👌 ok
🤌 pinched
✌️ victory
🤞 crossed_fingers
🤟 love_you
🤘 metal
🤙 call_me
👈 point_left
👉 point_right
👆 point_up
👇 point_down
✋ hand
🖐️ raised_hand
🖖 vulcan
👋 wave
🤝 handshake
🙏 pray
✍️ writing
💪 muscle
👏 clap
🙌 raised_hands
🤲 open_hands
🫶 heart_hands
❤️ heart
🧡 orange_heart
💛 yellow_heart
💚 green_heart
💙 blue_heart
💜 purple_heart
🖤 black_heart
🤍 white_heart
💔 broken_heart
💕 two_hearts
💖 sparkling_heart
💯 100
🔥 fire
✨ sparkles
⭐ star
🌟 star2
💫 dizzy
⚡ zap
💥 boom
💦 sweat_drops
💤 zzz
🎉 tada
🎊 confetti`],
  ['nature', `🐶 dog
🐱 cat
🐭 mouse
🐹 hamster
🐰 rabbit
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey_face
🙈 see_no_evil
🙉 hear_no_evil
🙊 speak_no_evil
🐔 chicken
🐧 penguin
🐦 bird
🦉 owl
🐺 wolf
🐴 horse
🦄 unicorn
🐝 bee
🦋 butterfly
🐞 lady_beetle
🐢 turtle
🐍 snake
🐙 octopus
🦀 crab
🐬 dolphin
🐳 whale
🐟 fish
🌵 cactus
🌲 evergreen_tree
🌳 tree
🌱 seedling
🌿 herb
🍀 four_leaf_clover
🍁 maple_leaf
🌸 cherry_blossom
🌻 sunflower
🌹 rose
🌈 rainbow
☀️ sun
⛅ partly_sunny
☁️ cloud
🌧️ rain
⛈️ storm
❄️ snowflake
⛄ snowman
🌊 wave
🌙 crescent_moon`],
  ['food', `🍎 apple
🍌 banana
🍇 grapes
🍓 strawberry
🍒 cherries
🍑 peach
🍍 pineapple
🥝 kiwi
🍅 tomato
🥑 avocado
🥕 carrot
🌽 corn
🍞 bread
🥐 croissant
🧀 cheese
🍔 hamburger
🍟 fries
🍕 pizza
🌭 hotdog
🌮 taco
🥗 salad
🍜 ramen
🍣 sushi
🍩 doughnut
🍪 cookie
🎂 cake
🍰 shortcake
🍫 chocolate
🍬 candy
🍭 lollipop
🍿 popcorn
☕ coffee
🍵 tea
🍺 beer
🍻 beers
🥂 champagne
🍷 wine
🥤 cup`],
  ['activities', `⚽ soccer
🏀 basketball
🏈 football
⚾ baseball
🎾 tennis
🏐 volleyball
🎱 8ball
🏓 ping_pong
🏸 badminton
🏆 trophy
🥇 first_place
🥈 second_place
🥉 third_place
🎮 video_game
🕹️ joystick
🎲 game_die
🎯 dart
🎤 microphone
🎧 headphones
🎵 musical_note
🎶 notes
🎸 guitar
🎹 piano
🥁 drum
🎬 clapper
🎨 art
🎭 performing_arts
🚀 rocket
🏁 checkered_flag`],
  ['objects', `💻 laptop
🖥️ desktop_computer
⌨️ keyboard
🖱️ mouse_three_button
📱 iphone
📷 camera
📺 tv
🔌 electric_plug
🔋 battery
💡 bulb
🔦 flashlight
🔧 wrench
🔨 hammer
🧰 toolbox
🔑 key
🔒 lock
📌 pushpin
📎 paperclip
✏️ pencil
📝 memo
📖 book
📚 books
💰 moneybag
💸 money_wings
💳 credit_card
🎁 gift
📦 package
✉️ envelope
📢 loudspeaker
🔔 bell
⏰ alarm_clock
⌛ hourglass
🔍 mag
🛒 shopping_cart`],
  ['symbols', `✅ white_check_mark
❌ x
⭕ o
❗ exclamation
❓ question
⚠️ warning
🚫 no_entry_sign
♻️ recycle
💬 speech_balloon
💭 thought_balloon
👀 eyes
🆕 new
🆒 cool
➕ heavy_plus_sign
➖ heavy_minus_sign
🔴 red_circle
🟠 orange_circle
🟡 yellow_circle
🟢 green_circle
🔵 blue_circle
🟣 purple_circle
⚫ black_circle
⚪ white_circle`]
]

function build(): Emoji[] {
  const list: Emoji[] = []
  for (const [group, block] of TABLE) {
    for (const line of block.split('\n')) {
      const [char, name, ...keywords] = line.trim().split(/\s+/u)
      if (!char || !name) continue
      list.push({ char, name, keywords: [name, ...keywords], group })
    }
  }
  return list
}

export const EMOJIS: readonly Emoji[] = build()
/** Groups keyed by identifier: their label lives in the catalog, the identity does not change with language. */
export const EMOJI_GROUPS: readonly string[] = TABLE.map(([group]) => group)
const BY_NAME = new Map(EMOJIS.map(emoji => [emoji.name, emoji]))

export function emojiByName(name: string): Emoji | undefined {
  return BY_NAME.get(name.toLowerCase())
}

/** Ranks on prefix first so ":fi" offers ":fire:" before ":confetti:". */
export function searchEmojis(term: string, limit = 60): Emoji[] {
  const needle = term.trim().toLowerCase()
  if (!needle) return EMOJIS.slice(0, limit)
  const scored: Array<{ emoji: Emoji; score: number }> = []
  for (const emoji of EMOJIS) {
    let score = 0
    // The shortcode does not change with language; the synonyms, however, come from the catalog.
    const aliases = m.emoji.aliases[emoji.name]
    for (const keyword of aliases ? [...emoji.keywords, ...aliases.split(' ')] : emoji.keywords) {
      if (keyword === needle) { score = Math.max(score, 4); continue }
      if (keyword.startsWith(needle)) { score = Math.max(score, 3); continue }
      if (keyword.includes(needle)) score = Math.max(score, 1)
    }
    if (emoji.name.startsWith(needle)) score = Math.max(score, 3.5)
    if (score) scored.push({ emoji, score })
  }
  scored.sort((left, right) => right.score - left.score || left.emoji.name.localeCompare(right.emoji.name))
  return scored.slice(0, limit).map(item => item.emoji)
}
