# TicketID

TicketID proves that a person was physically at a show, and uses that proof to give them priority access to ticket queues. Scalpers fill those queues with bots. Real fans then pay resale prices. A proved fan gets a code for the onsale. A bot that never stood at the show does not.

This folder is a new app. Nothing is carried over from other projects. There is no public website in this version.

## Purpose

Signing up does not make someone a fan. A successful scan does.

The scan happens inside the show, next to a receiver the band, venue, or festival has logged in. That receiver can be an iPad at the door or the band's own phone. The fan shows a one-time code as a QR. The receiver scans it. The account is then on the list for that night.

That list is what a band uses when tickets for the next show go on sale. Priority codes go only to people on it, and only inside the app. The queue the scalpers flood is no longer the only way in.

Username, email, and phone identify the account. They are not the defence against bots. The scan is.

## Priority access

A priority code is how the proof turns into a place at the front of a ticket release.

A band sends one code to a group it is allowed to reach: people who registered at a particular gig, people who registered on the last tour, or everyone who has ever registered with that band. Each person in the group gets their own code. It appears on their codes screen and nowhere else. No email. No text.

The code belongs to the account that was scanned. It is that account's priority access for the release the band is announcing.

A venue or festival can send a code the same way, to people who registered at a gig in that place. A venue might use it for priority tickets, or for an offer such as a free drink or money off.

Until a ticket seller checks the account itself, the characters of a code can still be read off the phone. This version creates the proved list and delivers the priority code to that account. Connecting a public ticket queue so it accepts the account directly comes later. The priority, in this version, is that only a proved fan is sent the code.

## Three apps

### Fan

The fan app uses a dark teal background and off-white text, the usual dark-mode white. That treatment covers login, signup, the QR screen, Gigs, Codes, and settings.

The name is written ticketID. ticket uses that same off-white. ID is a normal teal, lighter than the dark teal background. The name is shown on the login and signup page.

The first screen is a normal login and signup page. After a successful login the app opens on the QR screen.

Three screens sit in a horizontal row:

**Press to generate code.** This is the landing screen after login, and the whole check-in screen. The fan presses it when they are next to the receiver. The app shows a QR. The code works once, and only for a short time. A small settings cog sits in the top right of this screen only.

**Gigs.** Swipe right from the QR screen. Every event they have successfully registered at, shown as tiles of the gig image. The date sits at the bottom of the tile. A gig from the last year shows the day and the month. A gig older than a year shows the month and the year.

**Codes.** Swipe right again. Every priority code or offer sent to them, shown as tiles of the sender's profile picture. The sender is the band, the venue, or the festival. This is the only place a code appears.

The settings cog opens settings and profile editing: the preference to only get codes from bands they have registered with, hometown and city, account details, and sign out.

When a scan is accepted, the phone shows the gig image full screen with **You registered for {gig_name}** over it, then returns to **Press to generate code**.

### Receiver

The receiver logs in with an event id and a password issued by the dashboard for that gig or tour. After login it is passive. It does not choose people. Any valid fan code is accepted.

It idles on the gig or festival image. The bottom of the poster fades to black, and **Tap to Register** sits there in white. Tapping that opens the QR reader. **X** leaves the event on that device.

A successful scan keeps the same poster and replaces the bottom line with **Registration Success**, still in white. The receiver does not show the gig name. Then it returns to **Tap to Register**.

### Dashboard

Bands, venues, and festivals each have their own login and a profile picture. That picture is the tile on a fan's codes screen when they send a code.

From the dashboard they create gigs, confirm who is on the bill, open the receiver, see the groups their scans have built, and send priority codes to those groups.

## Accounts

A fan signs up with a username, an email address, and a phone number. Hometown and city are optional. If they are left blank, the app says they will get codes for upcoming gigs and tours in their hometown and country if they add those details.

A password exists so they can log back in. If they forget it, the email link opens ticketID and the new password is chosen there, with the same rules as signup.

Email verification waits until release. During this stage a fan, band, venue, or festival can sign up and use the account before the address is confirmed. The check itself is listed under Before release.

Hometown and city do one job. They make the account eligible for priority codes aimed at upcoming gigs and tours in that place. They are not a list other organisations can buy.

## Creating a gig

**Create gig** starts an empty gig. The creator then adds:

- Name
- Time
- Date
- Bio
- Image

The image is required. The fan's confirmation and the receiver's idle screen are both built from it. A band, a venue, or a festival can be the one who sets that poster.

The other party is added in person, on the night. Each band, venue, and festival can generate a short one-time code on their own dashboard. On the gig, **Add act** asks for a band's code. **Add venue** asks for a venue's code. Someone reads the code off the other dashboard and types it in. When the code is accepted, that organisation is on the gig and the code is spent. They can generate another code for a later gig.

The creator is already on the gig. A venue creating the night adds acts. A band creating the night adds the venue. A festival adds both.

This short code only joins the gig. It is separate from the event id and password that log the receiver in. Joining does not make that organisation the owner. Only the organisation that created the gig can change it, add someone else, take it live, or open the receiver. A new scanner code lets another phone join and leaves phones that are already signed in still signed in. The creator can see those phones and disconnect one of them. A band or venue that was added can see the gig and can still send a priority code to people who registered there.

The gig needs its name and image before anyone can register, because the fan's confirmation is that pair.

## Check-in

1. The receiver is logged into the gig and showing the poster.
2. The fan presses **Press to generate code**. The server issues a one-time code. The phone shows it as a QR. The QR carries that code and nothing else: no name, email, or phone.
3. The receiver taps **Tap to Register** and scans the QR.
4. The server attaches that fan account to that event a single time.
5. The phone shows **You registered for {gig_name}** over the gig image. The receiver shows **Registration Success**.

A second scan of the same code does nothing. The same fan at the same event remains one registration.

The proof has limits, and the product should keep them visible:

- The event password is the power to declare who attended. It stays with the people on the door.
- A photographed QR can be scanned by someone else until it expires. A short life makes that harder. It does not make it impossible.
- The scan shows that a logged-in receiver accepted this account's code. It is the practical stand-in for being inside the show, next to that receiver.

## Who a registration belongs to

One scan is shared by every organisation on the gig: the creator, each act added by code, and the venue added by code. Another band does not see it.

Those organisations are the ones who can later send that fan a priority code.

Groups an organisation can open, from its own history:

- People who registered at this gig
- People who registered at a gig on your last tour
- People who have ever registered at a gig of yours, or at a gig in your venue, or at your festival

A band that wants an audience it did not earn at its own shows has to pay. That payment is a real rule, and it is not built now. Genre-wide groups of fans are not built now. The dashboard should not offer a control that implies either one already works.

If a fan has chosen to hear only from bands they have registered with, a code from anyone else does not arrive. That includes a band that later pays for a wider group.

## What this version builds

- Fan signup, a login landing page, and the three screens on a dark teal background: QR, then swipe right to Gigs, then swipe right to Codes, with a settings cog on the QR screen
- Gig tiles with the date rule above, and code tiles that use the sender's profile picture
- Dashboard logins for a band, a venue, and a festival, each with a profile picture
- Create gig, then name, time, date, bio, and a required image
- A short one-time code on each organisation's dashboard, used by Add act and Add venue
- An event id and password for the receiver
- Generate, scan, the fan's named confirmation, and the receiver's poster with **Tap to Register** and **Registration Success**
- The proved list, as the groups above
- Sending a priority code, or a venue offer, into the app of the people in an allowed group, honouring the fan's opt-in

## Before release

Required before the app is released. Not part of the current build.

- Email verification. After signup, a message goes to that address with a confirmation link and a short code. The account stays closed until the person opens the link or enters the code. The same check applies to a band, venue, or festival, and again when an account changes its email. Changing the email also requires the current password, and the new address does not take effect until it is confirmed.
- Phone verification. A phone number belongs to one fan. The number is confirmed before it can be used to recover a password, so a reset cannot land on a different account that entered the same number.

## What waits

These stay out of this version. No screens and no data model for them yet.

- Payment for another band's audience
- Genre supergroups
- A public website
- A ticket queue that checks the fan's account directly, so a priority code cannot be passed to someone else

## Done when

A band or venue can sign in, create a gig with an image, and add the other party by typing a short code from that party's dashboard. A receiver can log in and idle on that image, with the bottom faded to black and **Tap to Register** in white.

A fan can log in and land on the QR screen, swipe right to Gigs and right again to Codes, and open settings from the cog. A fan can generate a code, the receiver can scan it, the phone can show **You registered for {gig_name}**, and the receiver can show **Registration Success**. The gig then appears on the fan's list.

A band can send a priority code to the people who registered at that gig. The code appears only on the codes screen of a fan who was scanned and who allows that sender. That code is their priority access for the ticket release.
