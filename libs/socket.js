"use strict";
var socket = {};

var Promise  = require('bluebird');
var debug    = require('debug')('socket')
var marked   = require('marked');

var redis    = require('../libs/redis')();
var Smileys  = require('../libs/smileys');
var sentence = require('./sentences');
var Users    = require('../models/users');
var Messages = require('../models/messages');

var users    = new Users(redis.client);
var messages = new Messages(redis.client);
var smileys  = new Smileys();

marked.setOptions({
  breaks: true,
  tables: false,
  sanitize: true,
  highlight: function(code) {
    return require('highlight.js').highlightAuto(code).value;
  }
});

var renderer = new marked.Renderer();

renderer.link = function(href, title, text) {
  return '<a target="_blank" href="'+ href +'">' + text + '</a>'
}

renderer.image = function(src) {
  return '<img class="img-fluid" src="' + src + '" > \
          <button type="button" class="btn btn-secondary btn-sm disclose">Afficher l\'image</button>'
}

renderer.paragraph = function(text) {
  return smileys.replace(text);
}

// Ping du client toutes les 50 secondes pour éviter
// un drop de la connexion par Heroku au bout de 55
// secondes (erreur H15)
var heartbeatInterval = 50000;

socket.init = function(io) {

  function sendHeartbeat() {
    setTimeout(sendHeartbeat, heartbeatInterval);
    io.emit('ping', { beat : 1 });
  }

  io.on('connection', function(socket) {

    var session = socket.handshake.session;
    var time = Date.now();

    if( ! session.user )
      return;

    session.user.socket = socket.id;

    return users.exist(session.user.name)
    .then(function(exist) {
      if(exist) throw new AlreadyConnectedError();
      else return Promise.resolve()
    })
    .then(function() {
      return users.banned(session.user.name).then(function(isBanned) {
        if(isBanned) throw new UserBannedError();
        else return Promise.resolve();
      });
    })
    .then(function() {
      users.add(session.user);
      io.emit('user_new', time, session.user.name);
      users.list().map(function(user) {
        io.emit('user_connected', user);
      });
    })
    .then(function() {
      // Réception la réponse (pong) du client
      socket.on('pong', function(data) {
        debug('Pong received from client');
      });
      // Réception d'un message
      socket.on('message', function(message) {
        if(message.trim() && message.length <= 1000) {
          addMessage(io, session.user, marked(message, { renderer:renderer }));
          var prob  = message.search(/chatbot/gi) !== -1 ? 10 : 400;
          if(getRandomInt({ emax:prob }) === 0) {
            var delay = getRandomInt({ min:5, max:15 }) * 1000;
            Promise.delay(delay).then(function() {
              chatbotSpeech(io, session.user.name);
            });
          }
        }
      });
      // Frappe au clavier
      socket.on('typing', function(isTyping) {
        socket.broadcast.emit('isTyping', {
          isTyping:isTyping,
          user:session.user.name
        });
      });
      // Suppression d'un message
      socket.on('remove_message', function(id) {
        io.emit('remove_message', id);
      });
      // Déconnexion de l'utilisateur
      socket.on('disconnect', function() {
        users.remove(session.user.name);
        time = Date.now();
        io.emit('user_disconnected', time, session.user);
      });
      // Ban d'un utilisateur par un admin
      socket.on('ban', function(username) {
        if(!session.user.isAdmin || username.toLowerCase() == session.user.name.toLowerCase())
          return;
        banUser(io, socket.id, username);
      });
      // Deban d'un utilisateur
      socket.on('unban', function(username) {
        if(!session.user.isAdmin)
          return;
        users.unban(username);
        addBotMessage(io, " Une seconde chance a été offerte à " + username, { storage:true });
      });
      // Liste des utilisateurs bannis
      socket.on('banlist', function() {
        if(!session.user.isAdmin)
          return;
        users.banlist().map(function(user) {
          return user.name;
        })
        .then(function(userslist) {
          var message = 'Liste (' + userslist.length + ') : ' + userslist.toString();
          addBotMessage(io, userslist.length > 0 ? message : "Personne n'a été banni :)", { socket:socket.id });
        });
      });
      // Débloquer un utilisateur
      socket.on('unlock', function(username) {
        if(!session.user.isAdmin)
          return;
        users.remove(username);
        addBotMessage(io, username + ' a été débloqué', { socket:socket.id });
      });
      // Utilisateur est AFK
      socket.on('afk', function() {
        session.user.status = 'afk';
        users.add(session.user);
        time = Date.now();
        io.emit('user_afk', time, session.user.name);
      });
      // Utilisateur n'est plus AFK
      socket.on('unafk', function() {
        session.user.status = 'online';
        users.add(session.user);
        time = Date.now();
        io.emit('user_unafk', time, session.user.name);
      });
      // Messages privés
      socket.on('private_message', function(username, message) {
        if(username.toLowerCase() == session.user.name.toLowerCase()) {
          addBotMessage(io, 'WTF, ' + session.user.name + ' se parle à lui même oO ...', { storage:true });
          return;
        }
        users.getUserSocket(username)
        .then(function(userSocket) {
          time = Date.now();
          if(message.trim() && message.length <= 1000) {
            var marksrc  = marked('*(chuchotte à **' + username + '**)* ' + message, { renderer:renderer });
            var markdest = marked('*(murmure)* ' + message, { renderer:renderer });
            io.to(socket.id).emit('message', { time:time, user:session.user, message:marksrc, private:true });
            io.to(userSocket).emit('message', { time:time, user:session.user, message:markdest, private:true });
            io.to(userSocket).emit('private_notification', session.user.name);
          }
        })
        .catch(function() {
          addBotMessage(io, '(' + username + ') utilisateur introuvable, transmission du message impossible...', { socket:socket.id });
        });
      });
      // Highlight d'un utilisateur
      socket.on('highlight', function(username) {
        if(username.toLowerCase() == session.user.name.toLowerCase()) {
          addBotMessage(io, 'WTF, ' + session.user.name + ' se poke lui même oO ...', { storage:true });
          return;
        }
        users.getUserSocket(username)
        .then(function(userSocket) {
          time = Date.now();
          addBotMessage(io, 'Vous avez poke @' + username, { socket:socket.id });
          io.to(userSocket).emit('user_highlight', time, session.user.name);
        })
        .catch(function() {
          addBotMessage(io, '(' + username + ') utilisateur introuvable...', { socket:socket.id });
        });
      });
      // Lancer un dé
      socket.on('roll', function(pattern) {
        if(!pattern) {
          addBotMessage(io, session.user.name + " lance 1d6 et obtient " + getRandomInt({ min:1, max:6 }), { storage:true });
          return;
        }

        var dice   = pattern.split('d');
        var number = parseInt(dice[0], 10);
        var sides  = parseInt(dice[1], 10);
        var result = [];

        number = (number > 0 && number <= 10)  ? number : 1 ;
        sides  = (sides  > 0 && sides  <= 100) ? sides  : 6 ;

        for(var i = 0; i < number; i++) {
          result.push(getRandomInt({ min:1, max:sides }));
        }

        var message = session.user.name + " lance " + number + "d" + sides + " et obtient " + result.toString();
        addBotMessage(io, message, { storage:true });
      });
      socket.on('rolluser', function(username) {
        users.getUserSocket(username)
        .then(function() {
          var message, storage;
          var lucky = getRandomInt({ emax:6000 });
          switch(lucky) {
            case 0:
              message = 'Bon, tu me fais pitié, je veux bien le kick !';
              storage = true;
              banUser(io, socket.id, username);
              break;
            case 5999:
              message = 'Tu vas arrêter de faire le con, oui ?';
              storage = true;
              banUser(io, socket.id, session.user.name);
              break;
            default:
              storage = false;
              message = 'La tentative a échoué, peut-être une autre fois, maintenant dégage. :hap:';
              break;
          }
          addBotMessage(io, "Quelqu'un a tenté un roll " + username + "...", { storage:storage });
          return Promise.delay(50).then(function() {
            return Promise.resolve({ message:message, storage:storage });
          })
        })
        .then(function(result) {
          addBotMessage(io, result.message, { storage:result.storage });
        })
        .catch(function() {
          addBotMessage(io, '(' + username + ') utilisateur introuvable...', { socket:socket.id });
        });
      });
    })
    .catch(AlreadyConnectedError, function() {
      Promise.delay(500).then(function() {
        io.to(socket.id).emit('already_connected');
      });
    })
    .catch(UserBannedError, function() {
      Promise.delay(500).then(function() {
        io.to(socket.id).emit('user_banned');
      });
    });
  });
  // Envoi du premier Heartbeat
  setTimeout(sendHeartbeat, heartbeatInterval);
};

var addMessage = function(io, user, message) {
  var time = Date.now();
  var data = { time:time, user:user, message:message };
  messages.add(time, user.name, message)
  .then(function(id) {
    data.id = id;
    io.emit('message', data);
  });
};

var addBotMessage = function(io, message, options) {
  var time = Date.now();
  var data = { type:'message-bot', time:time, message:message };
  if(!options) {
    io.emit('message', data);
    return;
  }
  if(options.storage)
    messages.add(time, null, message);
  if(options.socket)
    io.to(options.socket).emit('message', data);
  else
    io.emit('message', data);
};

var banUser = function(io, socketid, username) {
  users.getUserSocket(username)
  .then(function(userSocket) {
    users.ban(username);
    io.to(userSocket).emit('ban');
    addBotMessage(io, username + " a été kick du chat", { storage:true });
  })
  .catch(function() {
    addBotMessage(io, '(' + username + ') utilisateur introuvable...', { socket:socketid });
  });
}

function chatbotSpeech(io, username) {
  var messages = sentence.get();
  var index = getRandomInt({ emax:messages.length });
  addBotMessage(io, messages[index].replace('%user', username), { storage:true });
}

/*
 * Génére un nombre aléatoire selon le nombre de faces
 * Les valeurs min et max sont incluses [1-sides]
 */
function rollDice(sides) {
  return Math.floor(Math.random() * (sides - 1 + 1)) + 1;
}

/*
 * Génère un entier aléatoire
 *
 * Ranges possibles :
 * ----------------------------
 * { max:x }         // [0-x]
 * { min:x, max:y }  // [x-y]
 * { min:x, emax:y } // [x-y[
 * { emax:x }        // [0-x[
 * ----------------------------
 */
function getRandomInt(range) {
  if(!range.min) range.min = 0;
  if(range.max) // Inclusive max
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
  else if(range.emax) // Exclusive max
    return Math.floor(Math.random() * (range.emax - range.min)) + range.min;
}

// Déclaration des erreurs
function AlreadyConnectedError() {}
function UserBannedError() {}

// Déclaration des prototypes
AlreadyConnectedError.prototype = Object.create(Error.prototype);
UserBannedError.prototype = Object.create(Error.prototype);

module.exports = socket;
